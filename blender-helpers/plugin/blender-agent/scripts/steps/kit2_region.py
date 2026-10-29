"""kit2_region — centre and size of a region of the reference, ready to paste into kit2_part as `c` and `size`. Read-only.

You give a rough region as ranges on any of the three axes (metres); the verb takes the reference vertices inside it, drops the
outermost `trim_pct` percent on each axis (stray strands, nearby parts), and returns the tight box. Give ranges that
fit the part tightly in the direction where other parts are close (e.g. a belt: z 0.27 .. 0.38), and wide ranges elsewhere.

params:
  x, y, z    [min, max] metres, each optional (default: everything). +X is the character's left, +Y backwards, +Z up.
  object     object to measure (default "ref"; before kit2_body has named it, the only mesh in the scene is used)
  trim_pct   percent dropped at each end of each axis (default 2)
  mirror     true: also measure the region mirrored across x = 0 (the other side) and report how far the two sides differ.
             For a pair, kit2_part wants the LEFT side (x positive): use `c_left` and `size_left`.
Returns: low_confidence (true when fewer than 50 points were found: the box is what those few give, check it with a picture), n_points, c, size (metres, trimmed), min, max (untrimmed); with mirror also c_left, size_left, c_right, size_right and
asymmetry_mm (right minus left: centre x is the sum of the two, so 0 = symmetric; centre y, z and the three sizes are differences).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def box(v, lo, hi, trim):
    m = np.ones(len(v), dtype=bool)
    for a in range(3):
        m &= (v[:, a] >= lo[a]) & (v[:, a] <= hi[a])
    p = v[m]
    if len(p) < 5:
        return None
    a0, a1 = np.percentile(p, trim, axis=0), np.percentile(p, 100 - trim, axis=0)
    return {"low_confidence": bool(len(p) < 50), "n_points": int(len(p)), "c": [round(float(x), 4) for x in (a0 + a1) / 2], "size": [round(float(x), 4) for x in (a1 - a0)],
            "min": [round(float(x), 4) for x in p.min(0)], "max": [round(float(x), 4) for x in p.max(0)]}


def main():
    nm = L.param("object", "ref")
    o = bpy.data.objects.get(nm) or (L.the_mesh() if nm == "ref" else None)  # right after import_mesh the only mesh is the reference
    if o is None:
        raise RuntimeError(f"no object named {nm}")
    m = np.array(o.matrix_world)
    v = K.verts(o) @ m[:3, :3].T + m[:3, 3]  # world coordinates (the object may not have its transform applied yet)
    big = 1e9
    lo = [(L.param(a) or [-big, big])[0] for a in ("x", "y", "z")]
    hi = [(L.param(a) or [-big, big])[1] for a in ("x", "y", "z")]
    trim = float(L.param("trim_pct", 2))
    rep = box(v, lo, hi, trim)
    if rep is None:
        raise RuntimeError("fewer than 5 reference points inside this region: check the ranges")
    if L.param("mirror"):
        other = box(v, [-hi[0], lo[1], lo[2]], [-lo[0], hi[1], hi[2]], trim)
        if other is None:
            raise RuntimeError("the mirrored region holds fewer than 5 reference points")
        left, right = (rep, other) if rep["c"][0] > 0 else (other, rep)
        rep["low_confidence"] = bool(rep["low_confidence"] or other["low_confidence"])
        rep["c_left"], rep["size_left"] = left["c"], left["size"]
        rep["c_right"], rep["size_right"] = right["c"], right["size"]
        rep["asymmetry_mm"] = {"c": [round((right["c"][0] + left["c"][0]) * 1000, 1), round((right["c"][1] - left["c"][1]) * 1000, 1), round((right["c"][2] - left["c"][2]) * 1000, 1)],
                               "size": [round((right["size"][i] - left["size"][i]) * 1000, 1) for i in range(3)]}
    L.finish(rep, save=False)


L.run(main)