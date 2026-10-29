"""kit2_probe — read-only measurements for deciding a tweak (nothing is changed or saved).

Reports, in mm:
  kilt/belt heights on the part and on the reference (is the kilt's top band meant to hide under the belt?)
  buckler clearance to the head/neck of the body and of the reference
  harness gap to the body at the belly (x within 5 cm of the centre line, at belly height)
  sandal sole vs body foot: front/back y extents, and the sandal's z against the body's sole
  bracer: per side, the body ARM sections along the cuff's x-range (axis, half width, half height) and the cuff's own
          inner opening (per axis), so the needed scale is a number
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def zr(v, lo=None, hi=None):
    return [K.mm(v[:, 2].min()), K.mm(v[:, 2].max())]


def inner_opening(v, cy, cz):
    """cuff inner half-width (y) and half-height (z): the smallest radius in each angular sector, middle third in x."""
    x0, x1 = v[:, 0].min(), v[:, 0].max()
    m = (v[:, 0] > x0 + (x1 - x0) / 3) & (v[:, 0] < x1 - (x1 - x0) / 3)
    dy, dz = v[m, 1] - cy, v[m, 2] - cz
    ang = np.degrees(np.arctan2(dz, dy))
    rad = np.hypot(dy, dz)
    out = []
    for a in (0, 90, 180, 270):  # +y, +z, -y, -z
        sel = np.abs(((ang - a + 180) % 360) - 180) < 15
        out.append(float(rad[sel].min()) if sel.any() else None)
    return {"half_w_mm": K.mm(np.mean([out[0], out[2]])), "half_h_mm": K.mm(np.mean([out[1], out[3]])), "sectors_mm": [K.mm(x) for x in out]}


def arm_sections(bv, x0, x1, cy0, cz0):
    res = []
    for xs in np.linspace(x0, x1, 7):
        w = bv[(np.abs(bv[:, 0] - xs) < 0.006) & (np.abs(bv[:, 1] - cy0) < 0.12) & (np.abs(bv[:, 2] - cz0) < 0.12)]
        if len(w) < 40:
            continue
        cy, cz = float(w[:, 1].mean()), float(w[:, 2].mean())
        res.append([round(float(xs), 3), K.mm(cy), K.mm(cz), K.mm(np.percentile(np.abs(w[:, 1] - cy), 97)), K.mm(np.percentile(np.abs(w[:, 2] - cz), 97))])
    return res


def main():
    body = bpy.data.objects["body.001" if "body.001" in bpy.data.objects else "body"]
    ref = L.ref_object()
    bv, rv = K.verts(body), K.verts(ref)
    out = {}
    kilt, belt = K.verts(bpy.data.objects["kilt"]), K.verts(bpy.data.objects["belt"])
    ref_kilt = rv[(rv[:, 2] > 0.14) & (rv[:, 2] < 0.40) & (np.abs(rv[:, 0]) < 0.17) & (rv[:, 1] < 0.1)]
    out["z_mm"] = {"belt": zr(belt), "kilt": zr(kilt), "body_waist_top_hint": K.mm(bv[(np.abs(bv[:, 0]) < 0.1)][:, 2].min())}
    # kilt top band: the part's top 12 mm, its x extent
    top = kilt[kilt[:, 2] > kilt[:, 2].max() - 0.012]
    out["kilt_top_band"] = {"x_range_mm": [K.mm(top[:, 0].min()), K.mm(top[:, 0].max())], "y_range_mm": [K.mm(top[:, 1].min()), K.mm(top[:, 1].max())],
                            "belt_bottom_z_mm": K.mm(belt[:, 2].min()), "kilt_top_z_mm": K.mm(kilt[:, 2].max()),
                            "kilt_top_minus_belt_bottom_mm": K.mm(kilt[:, 2].max() - belt[:, 2].min())}
    # buckler clearance to head/neck
    head_b = bv[(bv[:, 2] > 0.60) & (np.abs(bv[:, 0]) < 0.14) & (bv[:, 1] < 0.05)]
    head_r = rv[(rv[:, 2] > 0.62) & (np.abs(rv[:, 0]) < 0.14) & (rv[:, 1] < 0.05)]
    th_b, th_r = K.kd(head_b), K.kd(head_r)
    for n in ("buckler_L", "buckler_R"):
        v = K.sample(K.verts(bpy.data.objects[n]), 3000, 5)
        _, db = K.nearest(th_b, v)
        _, dr = K.nearest(th_r, v)
        out[n] = {"to_body_head_min_mm": K.mm(db.min()), "to_ref_head_min_mm": K.mm(dr.min()), "centre_mm": [K.mm(x) for x in (K.verts(bpy.data.objects[n]).max(0) + K.verts(bpy.data.objects[n]).min(0)) / 2]}
    # harness vs body at the belly, front of the body
    hv = K.verts(bpy.data.objects["harness"])
    bb = K.bvh_of(body)
    hb = hv[(np.abs(hv[:, 0]) < 0.05) & (hv[:, 2] > 0.40) & (hv[:, 2] < 0.50)]
    if len(hb):
        sd = K.surf_signed(bb, K.sample(hb, 600, 3))
        out["harness_belly"] = {"n": int(len(hb)), "gap_median_mm": K.mm(np.median(sd)), "p5_mm": K.mm(np.percentile(sd, 5)), "p95_mm": K.mm(np.percentile(sd, 95))}
    # sandals vs the body's foot
    for sd_, n in ((1, "sandal_L"), (-1, "sandal_R")):
        sv = K.verts(bpy.data.objects[n])
        foot = bv[(bv[:, 2] < 0.05) & (bv[:, 0] * sd_ > 0.02) & (np.abs(bv[:, 0]) < 0.3)]
        out[n] = {"sandal_y_mm": [K.mm(sv[:, 1].min()), K.mm(sv[:, 1].max())], "body_foot_y_mm": [K.mm(foot[:, 1].min()), K.mm(foot[:, 1].max())],
                  "sandal_x_mm": [K.mm(sv[:, 0].min()), K.mm(sv[:, 0].max())], "body_foot_x_mm": [K.mm(foot[:, 0].min()), K.mm(foot[:, 0].max())],
                  "sandal_z_mm": zr(sv), "body_foot_z_min_mm": K.mm(foot[:, 2].min())}
    # bracers
    for sd_, n in ((1, "bracer_L"), (-1, "bracer_R")):
        v = K.verts(bpy.data.objects[n])
        cy0, cz0 = float(v[:, 1].mean()), float(v[:, 2].mean())
        secs = arm_sections(bv, v[:, 0].min() * 1.0, v[:, 0].max() * 1.0, cy0, cz0)
        ax = np.array(secs)
        cy, cz = (float(ax[:, 2].mean()) / 1000, float(ax[:, 3].mean()) / 1000) if len(ax) else (cy0, cz0)
        # the arm sections give (y, z) centres in mm in columns 1, 2
        cy, cz = (float(ax[:, 1].mean()) / 1000, float(ax[:, 2].mean()) / 1000) if len(ax) else (cy0, cz0)
        out[n] = {"cuff_centre_yz_mm": [K.mm(cy0), K.mm(cz0)], "arm_axis_yz_mm": [K.mm(cy), K.mm(cz)],
                  "arm_sections[x,cy,cz,halfW,halfH]_mm": secs, "cuff_inner": inner_opening(v, cy0, cz0),
                  "cuff_x_range_mm": [K.mm(v[:, 0].min()), K.mm(v[:, 0].max())]}
    L.finish(out, save=False)


L.run(main)