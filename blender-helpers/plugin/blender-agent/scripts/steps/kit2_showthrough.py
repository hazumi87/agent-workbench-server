"""kit2_showthrough — how much of the BODY can be seen where a named part should cover it. Read-only.

Every body vertex inside the part's region is sorted by two rays along its normal:
  - the OUTWARD ray hits the part            -> COVERED (the body point is under the part)
  - the outward ray misses, the INWARD ray hits the part within poke_mm
                                              -> VISIBLE (the body point is outside the part's surface: it pokes through)
  - both miss                                -> not under the part (beside it, or in a gap of an open part): left out of the count
visible_pct = visible / (covered + visible).
Meaningful for CLOSED rigid parts (cuffs, plates, sleeves). Open or slatted parts (kilts, sandals, straps) have gaps that
are left out, so a small number there does NOT mean the body is hidden: judge those with pictures.

params:
  part       object name of the part (required)
  body       object name of the body (default body.001 if present, else body)
  box        optional {c:[x,y,z], size:[x,y,z]} metres: test only body vertices inside this box
             (default: inside the part's own bounding box)
  reach_mm   outward ray length (default 150)
  poke_mm    inward ray length: how far a body point may be outside the part's surface and still count as poking through (default 40)
  axes       the two axes of the map, "xz" (default, front view), "xy" (top) or "yz" (side)
  grid       map size (default 8): grid x grid cells over the tested region
Returns: points_in_region, covered, visible, outside_part, visible_pct, where (centre/min/max of the visible points, mm), by_side (front/back/left/right
of the body surface), map (rows from the top; each cell is the visible share 0-9, '.' = no points), sample_points_mm.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def main():
    part = bpy.data.objects[L.param("part")]
    bname = L.param("body") or ("body.001" if "body.001" in bpy.data.objects else "body")
    body = bpy.data.objects[bname]
    pv = K.verts(part)
    box = L.param("box")
    if box:
        lo = np.array(box["c"]) - np.array(box["size"]) / 2
        hi = np.array(box["c"]) + np.array(box["size"]) / 2
    else:
        lo, hi = pv.min(0), pv.max(0)
    bv = K.verts(body)
    nrm = np.empty(len(bv) * 3)
    body.data.vertex_normals.foreach_get("vector", nrm)
    nrm = nrm.reshape(-1, 3)
    inside = np.all((bv >= lo) & (bv <= hi), axis=1)
    idx = np.flatnonzero(inside)
    if len(idx) == 0:
        raise RuntimeError("no body vertices inside the region: the part is not on the body, or the box is wrong")
    bvh = K.bvh_of(part)
    reach = float(L.param("reach_mm", 150)) / 1000
    poke = float(L.param("poke_mm", 40)) / 1000
    state = np.zeros(len(idx), dtype=np.int8)  # 0 outside the part, 1 covered, 2 visible (pokes through)
    for k, i in enumerate(idx):
        n = Vector(nrm[i])
        p = Vector(bv[i])
        if bvh.ray_cast(p + n * 1e-4, n, reach)[0] is not None:
            state[k] = 1
        elif bvh.ray_cast(p - n * 1e-4, -n, poke)[0] is not None:
            state[k] = 2
    sel = state > 0
    n_cov, n_vis, n_out = int((state == 1).sum()), int((state == 2).sum()), int((state == 0).sum())
    pts, ns, vis = bv[idx][sel], nrm[idx][sel], (state[sel] == 2)
    if len(pts) == 0:
        raise RuntimeError("no body point is under (or poking through) the part: check the part name and box")
    vp = pts[vis]
    ax = {"x": 0, "y": 1, "z": 2}
    a0, a1 = ax[L.param("axes", "xz")[0]], ax[L.param("axes", "xz")[1]]
    g = int(L.param("grid", 8))
    e0 = np.linspace(pts[:, a0].min(), pts[:, a0].max() + 1e-9, g + 1)
    e1 = np.linspace(pts[:, a1].min(), pts[:, a1].max() + 1e-9, g + 1)
    c0 = np.clip(np.digitize(pts[:, a0], e0) - 1, 0, g - 1)
    c1 = np.clip(np.digitize(pts[:, a1], e1) - 1, 0, g - 1)
    tot = np.zeros((g, g))
    vsh = np.zeros((g, g))
    np.add.at(tot, (c1, c0), 1)
    np.add.at(vsh, (c1, c0), vis.astype(float))
    rows = []
    for r in range(g - 1, -1, -1):  # the second axis grows upward in the picture
        rows.append("".join("." if tot[r, c] == 0 else str(min(9, int(10 * vsh[r, c] / tot[r, c]))) for c in range(g)))
    side = {}
    for nm, d in (("front", (0, -1, 0)), ("back", (0, 1, 0)), ("left", (1, 0, 0)), ("right", (-1, 0, 0)), ("up", (0, 0, 1)), ("down", (0, 0, -1))):
        m = (ns @ np.array(d)) > 0.5
        side[nm] = {"tested": int(m.sum()), "visible": int((vis & m).sum())}
    rep = {"part": part.name, "body": bname, "region_mm": [[K.mm(x) for x in lo], [K.mm(x) for x in hi]],
           "points_in_region": int(len(idx)), "covered": n_cov, "visible": n_vis, "outside_part": n_out,
           "visible_pct": round(100 * n_vis / max(1, n_cov + n_vis), 1),
           "where": None if not len(vp) else {"centre_mm": [K.mm(x) for x in vp.mean(0)], "min_mm": [K.mm(x) for x in vp.min(0)], "max_mm": [K.mm(x) for x in vp.max(0)]},
           "by_side": side, "map_axes": L.param("axes", "xz"), "map_rows_top_first": rows,
           "map_legend": "each cell = visible share of the body points in it, 0 (none) .. 9 (90-100%); '.' = no body points",
           "sample_points_mm": [[K.mm(x) for x in p] for p in vp[:: max(1, len(vp) // 10)][:10]]}
    L.finish(rep, save=False)


L.run(main)