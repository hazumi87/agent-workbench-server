"""kit2_probe2 — where do parts sink into / float off the body? (read-only)

For each named part: signed distance to the body for a sample of its vertices; reports how many points sink deeper than
`sink_mm`, and WHERE they are (centre and extents of the sunk points, plus a 3-bin split by height and by side),
and the same for points floating further than `float_mm`.
params: parts (list), sink_mm (default 8), float_mm (default 25)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def where(p):
    if len(p) == 0:
        return None
    return {"n": int(len(p)), "centre_mm": [K.mm(x) for x in p.mean(0)], "min_mm": [K.mm(x) for x in p.min(0)], "max_mm": [K.mm(x) for x in p.max(0)]}


def main():
    body = bpy.data.objects["body.001" if "body.001" in bpy.data.objects else "body"]
    bb = K.bvh_of(body)
    sink, flt = float(L.param("sink_mm", 8)) / 1000, float(L.param("float_mm", 25)) / 1000
    out = {}
    for n in L.param("parts"):
        v = K.sample(K.verts(bpy.data.objects[n]), 4000, 17)
        d = K.surf_signed(bb, v)
        out[n] = {"points": int(len(v)), "sunk_deeper_than_mm": K.mm(sink), "sunk": where(v[d < -sink]),
                  "floating_further_than_mm": K.mm(flt), "floating": where(v[d > flt]),
                  "hist_mm": {str(a): int(((d * 1000 >= a) & (d * 1000 < b)).sum()) for a, b in ((-100, -30), (-30, -15), (-15, -5), (-5, 5), (5, 15), (15, 30), (30, 100))}}
    L.finish(out, save=False)


L.run(main)