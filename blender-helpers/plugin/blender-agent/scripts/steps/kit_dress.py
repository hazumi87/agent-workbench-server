"""kit_dress — dress a base body with separately generated garments by overlap (no cuts, no remesh).

The job's mesh is the BODY. Every garment is a Library GLB; the jig is a fused dressed T-pose of the
same character, used only for placement. Per part: weld, find the placement by trimmed ICP against the
jig (per-axis scale + translation, with a few discrete start choices decided by the fit residual),
then decimate to a budget. Nothing is cut. Reports numeric checks.

params:
  jig         Library mesh id of the fused dressed T-pose
  parts       {name: {id, count?, size:[x,y,z], c:[x,y,z], mirror?:bool}}  (see EXAMPLE_SPECS below; there is no default)
  budgets     {name: tris}  (a part not listed uses "default")
  Part names with special handling: "bracer" (centred on its own arm axis, scaled to clear the arm), "harness" (settled onto the body), "buckler" (slid back until it touches the harness or body); any other name is fitted and decimated generically.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector, kdtree  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402

EXAMPLE_SPECS = {  # shape of the `parts` setting; every value here is synthetic (metres)
    "part_a": dict(id="<library-id>", c=[0, 0, 0.3], size=[0.3, 0.2, 0.1]),
    "part_b": dict(id="<library-id>", c=[0.1, 0, 0.5], size=[0.1, 0.1, 0.1], pair=True),
}
BUDGETS = {"body": 60000, "default": 12000}  # triangle budgets; override per part with the `budgets` setting


def lib(i):
    return L.resolve(i, what="library mesh") if L.is_id(i) else L.resolve(f"downloads/library/{i}.glb")


def verts(o):
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def set_verts(o, arr, flip_faces=False):
    o.data.vertices.foreach_set("co", arr.ravel())
    if flip_faces:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        bm.to_mesh(o.data)
        bm.free()
    o.data.update()


def weld(o, dist=1e-5):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=dist)
    bm.to_mesh(o.data)
    bm.free()


def import_glb(path, name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if len(new) != 1:
        raise RuntimeError(f"{path}: {len(new)} meshes")
    o = new[0]
    L.activate(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for e in [x for x in bpy.data.objects if x not in before and x.type != "MESH"]:
        bpy.data.objects.remove(e, do_unlink=True)
    o.name = name
    weld(o)
    return o


def kd(pts):
    t = kdtree.KDTree(len(pts))
    for i, p in enumerate(pts):
        t.insert(p, i)
    t.balance()
    return t


def nearest(tree, pts):
    idx = np.empty(len(pts), dtype=int)
    d = np.empty(len(pts))
    for i, q in enumerate(pts):
        _, j, dd = tree.find(q)
        idx[i], d[i] = j, dd
    return idx, d


def umeyama(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    u, d, vt = np.linalg.svd(dc.T @ sc / len(src))
    s_ = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        s_[2, 2] = -1
    r = u @ s_ @ vt
    s = np.trace(np.diag(d) @ s_) / ((sc ** 2).sum() / len(src))
    return s, r, mu_d - s * r @ mu_s


def fit_body(body_v, jig_v):
    """similarity ICP of the body to the jig (whole bodies)."""
    tree = kd(jig_v)
    rng = np.random.default_rng(0)
    sub = body_v[rng.choice(len(body_v), 4000, replace=False)]
    hs = (jig_v[:, 2].max() - jig_v[:, 2].min()) / (body_v[:, 2].max() - body_v[:, 2].min())
    p = sub * hs
    off = np.array([(jig_v[:, 0].max() + jig_v[:, 0].min()) / 2 - (p[:, 0].max() + p[:, 0].min()) / 2,
                    (jig_v[:, 1].max() + jig_v[:, 1].min()) / 2 - (p[:, 1].max() + p[:, 1].min()) / 2,
                    jig_v[:, 2].min() - p[:, 2].min()])
    p = p + off
    tot = np.eye(4)
    tot[:3, :3] *= hs
    tot[:3, 3] = off
    res = None
    for _ in range(30):
        idx, d = nearest(tree, p)
        sel = d <= np.quantile(d, 0.7)
        res = float(np.median(d[sel]))
        s, r, t = umeyama(p[sel], jig_v[idx[sel]])
        p = s * (p @ r.T) + t
        st = np.eye(4)
        st[:3, :3] = s * r
        st[:3, 3] = t
        tot = st @ tot
    return tot, res


def fit_part(src, jig_v, c, size, rot180, mirror, iters=40, keep=0.6):
    p0 = src.copy()
    if mirror:
        p0[:, 0] *= -1
    if rot180:
        p0[:, :2] *= -1
    lo, hi = p0.min(0), p0.max(0)
    s0 = np.array(size) / (hi - lo)
    s = s0.copy()
    t = np.array(c) - s * (lo + hi) / 2
    box_lo, box_hi = np.array(c) - np.array(size) / 2 - 0.04, np.array(c) + np.array(size) / 2 + 0.04
    reg = jig_v[np.all((jig_v >= box_lo) & (jig_v <= box_hi), axis=1)]
    if len(reg) < 200:
        return None
    tree = kd(reg)
    rng = np.random.default_rng(1)
    sub = p0[rng.choice(len(p0), min(len(p0), 3000), replace=False)]
    med = None
    for _ in range(iters):
        q = sub * s + t
        idx, d = nearest(tree, q)
        sel = d <= np.quantile(d, keep)
        med = float(np.median(d[sel]))
        tgt = reg[idx[sel]]
        x = sub[sel]
        for ax in range(3):
            vx = x[:, ax].var()
            if vx < 1e-12:
                continue
            sa = np.cov(x[:, ax], tgt[:, ax])[0, 1] / vx
            s[ax] = float(np.clip(sa, 0.6 * s0[ax], 1.6 * s0[ax]))
            t[ax] = tgt[:, ax].mean() - s[ax] * x[:, ax].mean()
    return dict(s=s, t=t, resid=med, rot180=rot180, mirror=mirror)


def apply_fit(o, src, f):
    p0 = src.copy()
    if f["mirror"]:
        p0[:, 0] *= -1
    if f["rot180"]:
        p0[:, :2] *= -1
    set_verts(o, p0 * f["s"] + f["t"], flip_faces=f["mirror"])


def decimate(o, target):
    weld(o)
    before = L.tris(o)
    if before <= target:
        return before, before
    L.activate(o)
    m = o.modifiers.new("Decimate", "DECIMATE")
    m.decimate_type = "COLLAPSE"
    m.ratio = target / before
    m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=m.name)
    return before, L.tris(o)


def mesh_checks(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    nm = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    seen = set()
    islands = 0
    for v0 in bm.verts:
        if v0.index in seen:
            continue
        islands += 1
        stack = [v0]
        seen.add(v0.index)
        while stack:
            v = stack.pop()
            for e in v.link_edges:
                w = e.other_vert(v)
                if w.index not in seen:
                    seen.add(w.index)
                    stack.append(w)
    bm.free()
    return {"non_manifold_edges": nm, "loose_islands": islands, "tris": L.tris(o)}


def vnormals(o):
    n = np.empty(len(o.data.vertices) * 3)
    o.data.vertex_normals.foreach_get("vector", n)
    return n.reshape(-1, 3)


def bvh_of(o):
    return BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())


def surf_signed(bvh, pts):
    """signed distance from points to the SURFACE (positive on the side the surface normal faces)."""
    out = np.empty(len(pts))
    for i, p in enumerate(pts):
        loc, nrm, _, dist = bvh.find_nearest(Vector(p))
        out[i] = dist if (Vector(p) - loc).dot(nrm) >= 0 else -dist
    return out


def settle_to_body(o, body_bvh, target=0.004, radius=0.03, cap=0.05):
    """Draw a floating garment toward the body: each vertex moves toward the body by (the smallest gap among
    the vertices within `radius` - target), then the move is smoothed, so a strap keeps its thickness."""
    v = verts(o)
    n = len(v)
    d = np.empty(n)
    dirs = np.zeros((n, 3))
    for i, p in enumerate(v):
        vp = Vector(p)
        loc, nrm, _, dist = body_bvh.find_nearest(vp)
        d[i] = dist if (vp - loc).dot(nrm) >= 0 else -dist
        if dist > 1e-9:
            dirs[i] = (loc - vp).normalized()
    tree = kd(v)
    near = [[j for (_, j, _) in tree.find_range(v[i], radius)] for i in range(n)]
    s = np.array([np.clip(d[nb].min() - target, 0, cap) for nb in near])
    s2 = np.array([s[nb].mean() for nb in near])
    set_verts(o, v + dirs * s2[:, None])
    return {"max_move_mm": round(float(s2.max()) * 1000, 1), "median_move_mm": round(float(np.median(s2)) * 1000, 1)}


def gap_and_cover(g, body, body_bvh):
    gv = verts(g)
    bv = verts(body)
    bn = vnormals(body)
    rng = np.random.default_rng(2)
    sub = gv[rng.choice(len(gv), min(len(gv), 4000), replace=False)]
    signed = surf_signed(body_bvh, sub)
    d = np.abs(signed)
    out = {"gap_median_mm": round(float(np.median(signed)) * 1000, 1),
           "sink_p5_mm": round(float(np.percentile(signed, 5)) * 1000, 1),
           "float_p95_mm": round(float(np.percentile(signed, 95)) * 1000, 1),
           "nearest_median_mm": round(float(np.median(d)) * 1000, 1)}
    # body vertices within 2 cm of the garment: is the body surface covered (a ray out of it hits the garment)?
    gtree = kd(gv)
    gb = BVHTree.FromObject(g, bpy.context.evaluated_depsgraph_get())
    idx2, d2 = nearest(gtree, bv)
    near = np.flatnonzero(d2 < 0.02)
    if len(near) > 6000:
        near = np.random.default_rng(3).choice(near, 6000, replace=False)
    exposed = 0
    for i in near:
        n = Vector(bn[i])
        hit = gb.ray_cast(Vector(bv[i]) + n * 1e-4, n, 0.08)[0]
        if hit is None:
            exposed += 1
    out["body_verts_within_2cm"] = int(len(near))
    out["body_exposed_pct"] = round(100 * exposed / max(1, len(near)), 1)
    return out


def main():
    jig_id = L.param("jig")
    specs = L.param("parts")
    if not jig_id or not specs:
        raise SystemExit("kit_dress needs the settings `jig` (Library id of the fitting reference) and `parts` (see EXAMPLE_SPECS in this file)")
    budgets = {**BUDGETS, **(L.param("budgets") or {})}
    body = L.the_mesh()
    body.name = "body"
    L.activate(body)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    weld(body)
    jig = import_glb(lib(jig_id), "jig")
    jv = verts(jig)
    bv0 = verts(body)
    tot, bres = fit_body(bv0, jv)
    set_verts(body, bv0 @ tot[:3, :3].T + tot[:3, 3])
    report = {"body_fit_scale": round(float(abs(np.linalg.det(tot[:3, :3])) ** (1 / 3)), 4),
              "body_fit_residual_mm": round(bres * 1000, 1), "parts": {}}
    placed = []
    for name, sp in specs.items():
        sides = [1, -1] if sp.get("pair") else [0]
        fits = {}
        for sd in sides:
            # the character faces -Y, so its left side is +X
            o = import_glb(lib(sp["id"]), f"{name}_{'L' if sd > 0 else 'R'}" if sd else name)
            src = verts(o)
            c = [sd * sp["c"][0] if sd else sp["c"][0], sp["c"][1], sp["c"][2]]
            best = None
            for rot in sp.get("rots", (False, True)):
                for mir in ((False, True) if sd else (False,)):
                    f = fit_part(src, jv, c, sp["size"], rot, mir)
                    if f and (best is None or f["resid"] < best["resid"]):
                        best = f
            if best is None:
                raise RuntimeError(f"{name}: no jig points near the expected spot")
            apply_fit(o, src, best)
            if sp.get("shift"):
                v = verts(o)
                v[:, 0] -= sd * float(sp["shift"])
                set_verts(o, v)
            fits[sd] = (o, best)
            placed.append(o)
        indep = {}
        if len(fits) == 2:
            # keep the better-fitting side and mirror it onto the other, so left and right are exact mirrors;
            # the independent fit of the other side is kept only to report how far the mirror is from it
            master = min(fits, key=lambda k: fits[k][1]["resid"])
            other = -master
            o_m, o_o = fits[master][0], fits[other][0]
            indep = {"verts": verts(o_o).copy()}
            mv = verts(o_m) * np.array([-1.0, 1.0, 1.0])
            if len(mv) != len(o_o.data.vertices):
                raise RuntimeError(f"{name}: sides differ in vertex count")
            # the other object's faces already have the winding of its own fit; reset to the master's, then reverse once
            bm = bmesh.new()
            bm.from_mesh(o_m.data)
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
            bm.to_mesh(o_o.data)
            bm.free()
            set_verts(o_o, mv)
            report.setdefault("mirrored_from", {})[name] = "L" if master > 0 else "R"
            # how far is the exact mirror from where the other side fitted on its own?
            tr = kd(indep["verts"])
            pick = np.random.default_rng(4).choice(len(mv), 3000, replace=False)
            _, dd = nearest(tr, mv[pick])
            indep["err"] = {"median": round(float(np.median(dd)) * 1000, 2), "p95": round(float(np.percentile(dd, 95)) * 1000, 2)}
        if name == "bracer":
            # the two arms are not mirror images in the body, so centre each bracer on ITS arm's axis
            bvv = verts(body)
            for sd_, (o_, f_) in fits.items():
                v_ = verts(o_)
                c_ = (v_.min(0) + v_.max(0)) / 2
                m_ = (np.abs(bvv[:, 0] - c_[0]) < 0.03) & (np.hypot(bvv[:, 1] - c_[1], bvv[:, 2] - c_[2]) < 0.09)
                if m_.sum() > 200:
                    cy, cz = float(bvv[m_, 1].mean()), float(bvv[m_, 2].mean())
                    v_[:, 1] += cy - c_[1]
                    v_[:, 2] += cz - c_[2]
                    # and make sure the arm fits inside: scale the bracer round its axis until its inner wall clears the arm
                    half = (v_[:, 0].max() - v_[:, 0].min()) / 2
                    # the arm's radius at the middle of the bracer (the ends include the muscle and the hand)
                    w_ = (np.abs(bvv[:, 0] - c_[0]) < 0.012) & (np.hypot(bvv[:, 1] - cy, bvv[:, 2] - cz) < 0.09)
                    r_arm = float(np.percentile(np.hypot(bvv[w_, 1] - cy, bvv[w_, 2] - cz), 92))
                    ay = float(np.percentile(np.abs(bvv[w_, 1] - cy), 97))  # the arm is not round: its half-width and half-height
                    az = float(np.percentile(np.abs(bvv[w_, 2] - cz), 97))
                    rad = np.hypot(v_[:, 1] - cy, v_[:, 2] - cz)  # v_ is already centred on the arm axis
                    r_in = float(np.percentile(rad, 3))
                    ring = rad < r_in * 1.15  # the inner wall
                    iy = float(np.abs(v_[ring, 1] - cy).max())
                    iz = float(np.abs(v_[ring, 2] - cz).max())
                    ky = min(2.1, max(1.0, (ay + 0.003) / iy))
                    kz = min(2.1, max(1.0, (az + 0.003) / iz))
                    v_[:, 1] = cy + (v_[:, 1] - cy) * ky
                    v_[:, 2] = cz + (v_[:, 2] - cz) * kz
                    v_[:, 0] = c_[0] + (v_[:, 0] - c_[0]) * (ky * kz) ** 0.25  # lengthen the cuff a little too
                    k = (ky + kz) / 2
                    set_verts(o_, v_)
                    report.setdefault("bracer_axis_shift_mm", {})[o_.name] = [round((cy - c_[1]) * 1000, 1), round((cz - c_[2]) * 1000, 1)]
                    report.setdefault("bracer_clearance", {})[o_.name] = {"arm_half_wh_mm": [round(ay * 1000, 1), round(az * 1000, 1)], "inner_half_wh_mm": [round(iy * 1000, 1), round(iz * 1000, 1)], "scale_yz": [round(ky, 3), round(kz, 3)]}
        entry = {k: {"scale": [round(float(x), 4) for x in v[1]["s"]], "centre": None,
                     "fit_resid_mm": round(v[1]["resid"] * 1000, 1), "rot180": v[1]["rot180"], "mirror": v[1]["mirror"]}
                 for k, v in fits.items()}
        for k, (o, f) in fits.items():
            lo, hi = verts(o).min(0), verts(o).max(0)
            entry[k]["centre"] = [round(float(x), 3) for x in (lo + hi) / 2]
            entry[k]["size"] = [round(float(x), 3) for x in (hi - lo)]
        if len(fits) == 2:
            entry["LR_mirror_vs_independent_fit_mm"] = indep["err"]
        report["parts"][name] = entry

    # decimate (weld first), then numeric checks
    bb, ba = decimate(body, budgets["body"])
    report["body_tris"] = [bb, ba]
    bpy.context.view_layer.update()
    body_bvh = bvh_of(body)
    total = ba
    for o in placed:
        base = o.name.split("_")[0]
        b, a = decimate(o, budgets.get(base, budgets["default"]))
        total += a
    bpy.data.objects.remove(jig, do_unlink=True)
    bpy.context.view_layer.update()
    if "harness" in bpy.data.objects:
        report["harness_settle"] = settle_to_body(bpy.data.objects["harness"], body_bvh)
        bpy.context.view_layer.update()
    # bucklers: slide each one straight back (+Y) until its back touches the harness or the body, then sink it 3 mm
    for o in placed:
        if o.name.split("_")[0] != "buckler":
            continue
        tg = [bvh_of(body)] + ([bvh_of(bpy.data.objects["harness"])] if "harness" in bpy.data.objects else [])
        gv_ = verts(o)
        best = None
        for p in gv_[:: max(1, len(gv_) // 2500)]:
            for tbvh in tg:
                hit = tbvh.ray_cast(Vector(p), Vector((0, 1, 0)), 0.2)
                if hit[0] is not None and (best is None or hit[3] < best):
                    best = hit[3]
        move = max(0.0, (best or 0.0) - 0.003) if (best or 1.0) < 0.1 else 0.0
        gv_[:, 1] += move
        set_verts(o, gv_)
        report.setdefault("buckler_settled_mm", {})[o.name] = round(move * 1000, 1)
    for o in placed:
        base = o.name.split("_")[0]
        chk = mesh_checks(o)
        chk.update(gap_and_cover(o, body, body_bvh))
        if base == "buckler" and "harness" in bpy.data.objects:
            gv_ = verts(o)
            dd_ = np.abs(surf_signed(bvh_of(bpy.data.objects["harness"]), gv_[:: max(1, len(gv_) // 3000)]))
            chk["to_harness_min_mm"] = round(float(dd_.min()) * 1000, 1)
            chk["to_harness_p5_mm"] = round(float(np.percentile(dd_, 5)) * 1000, 1)
            chk["to_harness_median_mm"] = round(float(np.median(dd_)) * 1000, 1)
            chk["to_harness_p95_mm"] = round(float(np.percentile(dd_, 95)) * 1000, 1)
        report["parts"][base].setdefault("checks", {})[o.name] = chk
    report["body_checks"] = mesh_checks(body)
    report["total_tris"] = total
    L.finish(report, save=True)


L.run(main)