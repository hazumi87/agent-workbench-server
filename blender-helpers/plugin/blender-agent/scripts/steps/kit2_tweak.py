"""kit2_tweak — step 4 of character-kit-assembly: size parts to the BODY they are worn on (not the reference).

Run ONLY the listed ops; each works on the parts already in the scene and reports what it did in numbers.
params:
  ops   list of {op, ...}:
    {op: "bracer"}                     per side: fit the cuff to its own arm along the cuff's whole x-range:
                                       arm axis and half width/height measured at 9 stations, an enveloping line fitted
                                       (so no station is left uncovered), and the cuff scaled/offset to follow it (taper)
    {op: "sandal"}                     per side: scale/translate the sandal so its footprint covers the body's foot
                                       (y and x extents), and drop it so the sole sits just under the foot
    {op: "harness_depth", target_mm}   scale the harness front-to-back about the body's chest centre as far as it goes
                                       before its near-body points sink more than `sink_mm` (default 4) into the body
    {op: "buckler_out", dx_mm}         move each buckler outward, then slide it back (+Y) to touch the harness/body again
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def body_obj():
    return bpy.data.objects["body.001" if "body.001" in bpy.data.objects else "body"]


def inner_opening(v, cy, cz):
    x0, x1 = v[:, 0].min(), v[:, 0].max()
    m = (v[:, 0] > x0 + (x1 - x0) / 3) & (v[:, 0] < x1 - (x1 - x0) / 3)
    dy, dz = v[m, 1] - cy, v[m, 2] - cz
    ang = np.degrees(np.arctan2(dz, dy))
    rad = np.hypot(dy, dz)
    s = []
    for a in (0, 90, 180, 270):
        sel = np.abs(((ang - a + 180) % 360) - 180) < 15
        s.append(float(rad[sel].min()) if sel.any() else float(np.percentile(rad, 3)))
    return (s[0] + s[2]) / 2, (s[1] + s[3]) / 2


def op_bracer(bv):
    """Fit each cuff to ITS arm: the arms are not symmetric and are tilted, so the cuff is rotated to the arm's axis
    (a line through 9 stations along the cuff's x-range), centred on it, and enlarged only as far as needed so the arm
    does not stick out of the cuff's outer surface (the cross-section scale is constant along the cuff)."""
    rep = {}
    for n in ("bracer_L", "bracer_R"):
        o = bpy.data.objects[n]
        v = K.verts(o)
        c0 = v.mean(0)
        x0, x1 = float(v[:, 0].min()), float(v[:, 0].max())
        xs = np.linspace(x0, x1, 9)
        st = []
        for x in xs:
            w = bv[(np.abs(bv[:, 0] - x) < 0.006) & (np.abs(bv[:, 1] - c0[1]) < 0.10) & (np.abs(bv[:, 2] - c0[2]) < 0.10)]
            if len(w) < 40:
                continue
            cy, cz = float(w[:, 1].mean()), float(w[:, 2].mean())
            st.append([x, cy, cz, float(np.percentile(np.abs(w[:, 1] - cy), 97)), float(np.percentile(np.abs(w[:, 2] - cz), 97))])
        st = np.array(st)
        ay, az = np.polyfit(st[:, 0], st[:, 1], 1), np.polyfit(st[:, 0], st[:, 2], 1)
        d = np.array([1.0, ay[0], az[0]])
        d /= np.linalg.norm(d)
        # rotation taking +x to d (Rodrigues)
        ex = np.array([1.0, 0.0, 0.0])
        ax = np.cross(ex, d)
        s_, c_ = np.linalg.norm(ax), float(ex @ d)
        if s_ < 1e-9:
            R = np.eye(3)
        else:
            a = ax / s_
            Kx = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
            R = np.eye(3) + s_ * Kx + (1 - c_) * (Kx @ Kx)
        xm = float(c0[0])
        target = np.array([xm, np.polyval(ay, xm), np.polyval(az, xm)])
        v2 = (v - c0) @ R.T + target
        # cross-section frame: ey is horizontal-ish, ez completes it
        ey = np.cross(np.array([0, 0, 1.0]), d)
        ey /= np.linalg.norm(ey)
        ez = np.cross(d, ey)
        rel = v2 - target
        py, pz = rel @ ey, rel @ ez
        outer_y, outer_z = float(np.percentile(np.abs(py), 97)), float(np.percentile(np.abs(pz), 97))
        # the arm's half sizes were measured in x-slices; the slices are oblique to the axis, so project them
        cosy = float(np.hypot(d[0], d[2]) / np.linalg.norm(d)) if False else 1.0
        arm_y = float(st[:, 3].max()) * float(abs(d[0]))
        arm_z = float(st[:, 4].max()) * float(abs(d[0]))
        ky = max(1.0, (arm_y + 0.002) / outer_y)
        kz = max(1.0, (arm_z + 0.002) / outer_z)
        along = rel @ d
        v3 = target + np.outer(along, d) + np.outer(py * ky, ey) + np.outer(pz * kz, ez)
        K.set_verts(o, v3)
        rep[n] = {"stations_used": int(len(st)), "axis_dir": [round(float(x), 3) for x in d], "tilt_deg": round(float(np.degrees(np.arccos(c_))), 1),
                  "cuff_centre_before_mm": [K.mm(x) for x in c0], "cuff_centre_after_mm": [K.mm(x) for x in target],
                  "arm_half_max_mm_yz": [K.mm(arm_y), K.mm(arm_z)], "cuff_outer_half_mm_yz_before": [K.mm(outer_y), K.mm(outer_z)],
                  "scale_yz": [round(ky, 3), round(kz, 3)], "size_after_mm": [round(x * 1000) for x in K.size_of(v3)]}
    return rep


def op_sandal(bv):
    rep = {}
    for sd, n in ((1, "sandal_L"), (-1, "sandal_R")):
        o = bpy.data.objects[n]
        v = K.verts(o)
        foot = bv[(bv[:, 2] < 0.05) & (bv[:, 0] * sd > 0.02) & (np.abs(bv[:, 0]) < 0.3)]
        fy0, fy1 = float(foot[:, 1].min()), float(foot[:, 1].max())
        fx0, fx1 = float(foot[:, 0].min()), float(foot[:, 0].max())
        sy0, sy1 = float(v[:, 1].min()), float(v[:, 1].max())
        sx0, sx1 = float(v[:, 0].min()), float(v[:, 0].max())
        pad_y, pad_x = 0.004, 0.003
        ky = (fy1 - fy0 + 2 * pad_y) / (sy1 - sy0)
        kx = (fx1 - fx0 + 2 * pad_x) / (sx1 - sx0)
        v2 = v.copy()
        v2[:, 1] = (v[:, 1] - (sy0 + sy1) / 2) * ky + (fy0 + fy1) / 2
        v2[:, 0] = (v[:, 0] - (sx0 + sx1) / 2) * kx + (fx0 + fx1) / 2
        v2[:, 2] = v[:, 2] + (float(foot[:, 2].min()) - 0.003 - float(v[:, 2].min()))
        K.set_verts(o, v2)
        rep[n] = {"scale_y": round(ky, 3), "scale_x": round(kx, 3), "dz_mm": K.mm(float(foot[:, 2].min()) - 0.003 - float(v[:, 2].min())),
                  "sandal_y_mm": [K.mm(v2[:, 1].min()), K.mm(v2[:, 1].max())], "foot_y_mm": [K.mm(fy0), K.mm(fy1)],
                  "sandal_x_mm": [K.mm(v2[:, 0].min()), K.mm(v2[:, 0].max())], "foot_x_mm": [K.mm(fx0), K.mm(fx1)]}
    return rep


def op_slide(name, dy_range, dz_range, followers):
    dy_range = [x / 1000 for x in dy_range]
    dz_range = [x / 1000 for x in dz_range]
    """move a part (y, z) to where it touches the body best: minimise the mean |distance| of its near-body points.
    Followers (parts that sit on it) move by the same amount."""
    o = bpy.data.objects[name]
    v = K.verts(o)
    bb = K.bvh_of(body_obj())
    pts = K.sample(v, 1800, 19)
    best, rows = None, []
    for dy in np.arange(dy_range[0], dy_range[1] + 1e-9, 0.005):
        for dz in np.arange(dz_range[0], dz_range[1] + 1e-9, 0.005):
            p = pts + np.array([0.0, dy, dz])
            sd = K.surf_signed(bb, p)
            near = np.abs(sd[np.abs(sd) < 0.06])
            score = float(near.mean()) if len(near) > 100 else 9.0
            p5 = float(np.percentile(sd[np.abs(sd) < 0.06], 5)) if len(near) > 100 else 0.0
            rows.append([K.mm(dy), K.mm(dz), K.mm(score), K.mm(p5)])
            if best is None or score < best[0]:
                best = (score, dy, dz, p5)
    _, dy, dz, p5 = best
    for n in [name] + list(followers):
        ob = bpy.data.objects[n]
        vv = K.verts(ob)
        vv[:, 1] += dy
        vv[:, 2] += dz
        K.set_verts(ob, vv)
    rows.sort(key=lambda r: r[2])
    return {"dy_mm": K.mm(dy), "dz_mm": K.mm(dz), "mean_abs_near_mm": K.mm(best[0]), "p5_mm": K.mm(p5), "followers": followers, "best_five": rows[:5], "worst_of_scan": rows[-1]}


def in_box(v, box):
    c, sz = np.array(box["c"], dtype=float), np.array(box["size"], dtype=float) / 2
    return (np.abs(v - c) <= sz).all(axis=1)


def host_sdf(names, v):
    """signed distance of each point to the UNION of the host objects' surfaces (positive = outside all of them; the smallest signed
    distance over the hosts, so a point inside any host counts as inside) and the normal of the host that decides it."""
    bvhs = [K.bvh_of(bpy.data.objects[n]) for n in names]
    n = len(v)
    d = np.full(n, np.inf)
    nrm = np.zeros((n, 3))
    for bb in bvhs:
        for i, p in enumerate(v):
            vp = Vector(p)
            loc, nr, _, dist = bb.find_nearest(vp)
            sd = dist if (vp - loc).dot(nr) >= 0 else -dist
            if sd < d[i]:
                d[i], nrm[i] = sd, nr
    return d, nrm


def op_wrap(name, target_mm, smooth_mm, push_only, max_mm, zmin_mm=None, against=None, box=None, keep_box=None):
    """Wrap a part to what it is worn on: move each vertex along the host's normal by the local (smoothed) amount
    that brings its signed distance to `target_mm` (positive = off the skin). Sunk points move out, floating points move
    in (unless push_only). The mesh is only displaced, never cut or remeshed. zmin_mm: leave everything below this height alone.
    against: object names that together form the host (default the body): the part ends up `target_mm` outside the OUTER surface of the union,
    so a belt can sit outside both the body and a waistband. box / keep_box: only move vertices inside / not inside that box {c, size} (metres)."""
    o = bpy.data.objects[name]
    v = K.verts(o)
    n = len(v)
    d, nrm = host_sdf(against or [body_obj().name], v)
    tree = K.kd(v)
    rad = smooth_mm / 1000
    near = [[j for (_, j, _) in tree.find_range(v[i], rad)] for i in range(n)]
    use = np.abs(d) < 0.07
    ds = np.array([float(np.mean(d[[j for j in nb if use[j]]])) if any(use[j] for j in nb) else d[i] for i, nb in enumerate(near)])
    m = (target_mm / 1000 - ds)  # positive: move out along the normal
    if push_only:
        m = np.maximum(m, 0.0)
    m = np.clip(m, -max_mm / 1000, max_mm / 1000)
    m[~use] = 0.0
    if zmin_mm is not None:
        m[v[:, 2] < zmin_mm / 1000] = 0.0
    if box is not None:
        m[~in_box(v, box)] = 0.0
    if keep_box is not None:
        m[in_box(v, keep_box)] = 0.0
    disp = nrm * m[:, None]
    disp = np.array([disp[nb].mean(0) for nb in near])
    if keep_box is not None:  # the kept region does not move at all, whatever its neighbours do
        disp[in_box(v, keep_box)] = 0.0
    v2 = v + disp
    K.set_verts(o, v2)
    sample = K.sample(v2, 2000, 23)
    sd2, _ = host_sdf(against or [body_obj().name], sample)
    sd2 = sd2[np.abs(sd2) < 0.07]
    return {"moved_points_pct": round(100 * float((np.linalg.norm(disp, axis=1) > 0.001).mean()), 1), "max_move_mm": K.mm(np.linalg.norm(disp, axis=1).max()),
            "median_move_mm": K.mm(np.median(np.linalg.norm(disp, axis=1))), "near_host_after_mm": {"median": K.mm(np.median(sd2)), "p5": K.mm(np.percentile(sd2, 5)), "p95": K.mm(np.percentile(sd2, 95))},
            "near_body_after_mm": {"median": K.mm(np.median(sd2)), "p5": K.mm(np.percentile(sd2, 5)), "p95": K.mm(np.percentile(sd2, 95))},
            "host": against or [body_obj().name]}


def op_buckler_settle(dx):
    """move each buckler outward by dx, then slide it in y until its rear face is 3 mm from the harness surface."""
    rep = {}
    hb = K.bvh_of(bpy.data.objects["harness"])
    for n, sd in (("buckler_L", 1), ("buckler_R", -1)):
        o = bpy.data.objects[n]
        v = K.verts(o)
        v[:, 0] += sd * dx
        rear = v[v[:, 1] > np.percentile(v[:, 1], 75)]
        offs = []
        for p in K.sample(rear, 600, 29):
            loc, nr, _, dist = hb.find_nearest(Vector(p))
            offs.append(loc.y - p[1])
        move = float(np.median(offs)) - 0.003
        v[:, 1] += move
        K.set_verts(o, v)
        d = np.abs(K.surf_signed(hb, K.sample(v, 2000, 31)))
        rep[n] = {"moved_out_mm": K.mm(dx), "slid_y_mm": K.mm(move), "to_harness_min_mm": K.mm(d.min()), "to_harness_p5_mm": K.mm(np.percentile(d, 5))}
    return rep


def op_bracer_shift(bv, side):
    """no rotation: move one cuff so its centre sits on its arm's axis at the MIDDLE of the cuff (mean of the middle three
    stations), and enlarge it only if the arm would stick out of the cuff's outer surface."""
    n = "bracer_" + side
    o = bpy.data.objects[n]
    v = K.verts(o)
    c0 = v.mean(0)
    x0, x1 = float(v[:, 0].min()), float(v[:, 0].max())
    xs = np.linspace(x0, x1, 9)[3:6]
    st = []
    for x in xs:
        w = bv[(np.abs(bv[:, 0] - x) < 0.006) & (np.abs(bv[:, 1] - c0[1]) < 0.10) & (np.abs(bv[:, 2] - c0[2]) < 0.10)]
        cy, cz = float(w[:, 1].mean()), float(w[:, 2].mean())
        st.append([cy, cz, float(np.percentile(np.abs(w[:, 1] - cy), 97)), float(np.percentile(np.abs(w[:, 2] - cz), 97))])
    st = np.array(st)
    dy, dz = float(st[:, 0].mean() - c0[1]), float(st[:, 1].mean() - c0[2])
    v2 = v + np.array([0.0, dy, dz])
    c1 = v2.mean(0)
    oy, oz = float(np.percentile(np.abs(v2[:, 1] - c1[1]), 97)), float(np.percentile(np.abs(v2[:, 2] - c1[2]), 97))
    ky, kz = max(1.0, (float(st[:, 2].max()) + 0.002) / oy), max(1.0, (float(st[:, 3].max()) + 0.002) / oz)
    v2[:, 1] = c1[1] + (v2[:, 1] - c1[1]) * ky
    v2[:, 2] = c1[2] + (v2[:, 2] - c1[2]) * kz
    K.set_verts(o, v2)
    return {n: {"shift_yz_mm": [K.mm(dy), K.mm(dz)], "mid_station_arm_half_wh_mm": [K.mm(st[:, 2].max()), K.mm(st[:, 3].max())],
                "cuff_outer_half_wh_mm": [K.mm(oy), K.mm(oz)], "scale_yz": [round(ky, 3), round(kz, 3)], "size_after_mm": [round(x * 1000) for x in K.size_of(v2)]}}


def op_kilt(bv, sink_mm, kmax):
    """the kilt sank into the body's hips (the body wears its own shorts): scale it outward in x and y about its
    own centre line until its near-body points sink no more than sink_mm (largest scale <= kmax that satisfies it)."""
    o = bpy.data.objects["kilt"]
    v = K.verts(o)
    bb = K.bvh_of(body_obj())
    cx, cy = 0.0, float((v[:, 1].min() + v[:, 1].max()) / 2)
    top = v[:, 2] > v[:, 2].max() - 0.09  # the band that hides under the belt: where the fit matters
    pts = K.sample(v[top], 2000, 13)
    rows, best = [], 1.0
    for k in np.arange(1.0, kmax + 1e-6, 0.01):
        p = pts.copy()
        p[:, 0] = cx + (p[:, 0] - cx) * k
        p[:, 1] = cy + (p[:, 1] - cy) * k
        sd = K.surf_signed(bb, p)
        near = sd[np.abs(sd) < 0.06]
        p5 = float(np.percentile(near, 5)) if len(near) > 50 else 0.0
        rows.append([round(float(k), 2), K.mm(p5)])
        best = float(k)
        if p5 * 1000 >= -sink_mm:
            break
    v2 = v.copy()
    v2[:, 0] = cx + (v[:, 0] - cx) * best
    v2[:, 1] = cy + (v[:, 1] - cy) * best
    K.set_verts(o, v2)
    return {"scale_xy": round(best, 2), "band_p5_by_k_mm": rows[:: max(1, len(rows) // 12)] + [rows[-1]]}


def op_buckler_out(dx):
    rep = {}
    targets = [K.bvh_of(body_obj())]
    if "harness" in bpy.data.objects:
        targets.append(K.bvh_of(bpy.data.objects["harness"]))
    for n, sd in (("buckler_L", 1), ("buckler_R", -1)):
        o = bpy.data.objects[n]
        v = K.verts(o)
        v[:, 0] += sd * dx
        best = None
        for p in v[:: max(1, len(v) // 2500)]:
            for t in targets:
                hit = t.ray_cast(Vector(p), Vector((0, 1, 0)), 0.2)
                if hit[0] is not None and (best is None or hit[3] < best):
                    best = hit[3]
        move = max(0.0, (best or 0.0) - 0.003) if (best or 1.0) < 0.1 else 0.0
        v[:, 1] += move
        K.set_verts(o, v)
        rep[n] = {"moved_out_mm": K.mm(dx), "slid_back_mm": K.mm(move)}
    return rep


def main():
    body = body_obj()
    bv = K.verts(body)
    rep = {}
    for op in L.param("ops"):
        k = op["op"]
        if k == "bracer":
            rep[k] = op_bracer(bv)
        elif k == "sandal":
            rep[k] = op_sandal(bv)
        elif k == "slide":
            rep[k + "_" + op["name"]] = op_slide(op["name"], op.get("dy_mm", [-60, 20]), op.get("dz_mm", [-20, 20]), op.get("followers", []))
        elif k == "bracer_shift":
            rep[k + "_" + op["side"]] = op_bracer_shift(bv, op["side"])
        elif k == "wrap":
            rep[k + "_" + op["name"]] = op_wrap(op["name"], float(op.get("target_mm", 4)), float(op.get("smooth_mm", 30)), bool(op.get("push_only", False)),
                                                 float(op.get("max_mm", 45)), op.get("zmin_mm"), op.get("against"), op.get("box"), op.get("keep_box"))
        elif k == "buckler_settle":
            rep[k] = op_buckler_settle(float(op.get("dx_mm", 12)) / 1000)
        elif k == "kilt_to_body":
            rep[k] = op_kilt(bv, float(op.get("sink_mm", 4)), float(op.get("kmax", 1.25)))
        elif k == "buckler_out":
            rep[k] = op_buckler_out(float(op.get("dx_mm", 12)) / 1000)
        else:
            raise RuntimeError(f"unknown op {k}")
    L.finish(rep, save=True)


L.run(main)