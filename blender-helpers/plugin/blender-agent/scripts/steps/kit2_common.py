"""kit2_common — shared helpers for the character-kit-assembly steps (kit2_body, kit2_part, kit2_view, kit2_tweak)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector, kdtree  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402


def lib(i):
    return L.resolve(i, what="library mesh") if L.is_id(i) else L.resolve(f"downloads/library/{i}.glb")


def verts(o):
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def set_verts(o, arr, flip_faces=False):
    o.data.vertices.foreach_set("co", np.asarray(arr, dtype=np.float64).ravel())
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
    o.data.name = name
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


def proportion_warning(name, a, b, limit=5.0):
    """a warning string when a part's width:height:depth changed by more than `limit` percent between two proportions() dicts, else None."""
    pct = proportion_change_pct(a, b)
    if pct is None or pct <= limit:
        return None
    ra, rb = a["ratio_whd"], b["ratio_whd"]
    return (f"{name}: width:height:depth changed by {pct}% (height/width {ra[1]} -> {rb[1]}, {round(100 * (rb[1] / ra[1] - 1), 1):+}%; "
            f"depth/width {ra[2]} -> {rb[2]}, {round(100 * (rb[2] / ra[2] - 1), 1):+}%). A rigid part should keep its proportions: use uniform scale")


def bvh_of(o):
    return BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())


def surf_signed(bvh, pts):
    """signed distance from points to the SURFACE (positive on the side the normal faces)."""
    out = np.empty(len(pts))
    for i, p in enumerate(pts):
        loc, nrm, _, dist = bvh.find_nearest(Vector(p))
        out[i] = dist if (Vector(p) - loc).dot(nrm) >= 0 else -dist
    return out


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


def fit_part(src, ref_v, c, size, rot180, mirror, iters=40, keep=0.6, fix_scale=False, uniform=False):
    """trimmed ICP of a part onto the reference: per-axis scale + translation, no rotation.
    start: bounding box matched to the expected box (c, size)."""
    p0 = src.copy()
    if mirror:
        p0[:, 0] *= -1
    if rot180:
        p0[:, :2] *= -1
    lo, hi = p0.min(0), p0.max(0)
    s0 = np.array(size) / (hi - lo)
    if uniform:  # one factor for all three axes: the part keeps its own proportions
        s0 = np.full(3, float(np.median(s0)))
    s = s0.copy()
    t = np.array(c) - s * (lo + hi) / 2
    box_lo, box_hi = np.array(c) - np.array(size) / 2 - 0.04, np.array(c) + np.array(size) / 2 + 0.04
    reg = ref_v[np.all((ref_v >= box_lo) & (ref_v <= box_hi), axis=1)]
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
            if not fix_scale and not uniform:
                sa = np.cov(x[:, ax], tgt[:, ax])[0, 1] / vx
                s[ax] = float(np.clip(sa, 0.6 * s0[ax], 1.6 * s0[ax]))
            t[ax] = tgt[:, ax].mean() - s[ax] * x[:, ax].mean()
        if uniform and not fix_scale:
            cv = sum(np.cov(x[:, a], tgt[:, a])[0, 1] for a in range(3))
            vr = sum(x[:, a].var() for a in range(3))
            s[:] = float(np.clip(cv / vr, 0.6 * s0[0], 1.6 * s0[0]))
            for ax in range(3):
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


def size_of(v):
    return [round(float(x), 3) for x in (v.max(0) - v.min(0))]


def centre_of(v):
    return [round(float(x), 3) for x in (v.max(0) + v.min(0)) / 2]


def sample(a, n=3000, seed=2):
    if len(a) <= n:
        return a
    return a[np.random.default_rng(seed).choice(len(a), n, replace=False)]


def mm(x):
    return round(float(x) * 1000, 1)


def measure(v):
    """body measurements in metres at the places parts sit. v = world vertices of a character (z up, faces -Y)."""
    out = {}
    z0 = v[:, 2].min()
    out["height"] = float(v[:, 2].max() - z0)

    def slc(z_lo, z_hi, xlim=0.2):
        s = v[(v[:, 2] >= z_lo) & (v[:, 2] < z_hi) & (np.abs(v[:, 0]) < xlim)]
        return s

    for nm_, (a, b) in {"hip": (0.20, 0.24), "waist": (0.30, 0.34), "chest": (0.44, 0.48)}.items():
        s = slc(a, b)
        if len(s):
            out[nm_ + "_width"] = float(s[:, 0].max() - s[:, 0].min())
            out[nm_ + "_depth"] = float(s[:, 1].max() - s[:, 1].min())
    for sd, nm_ in ((1, "L"), (-1, "R")):  # +X is the character's left (it faces -Y)
        s = v[(v[:, 2] >= 0.06) & (v[:, 2] < 0.10) & (v[:, 0] * sd > 0.02) & (np.abs(v[:, 0]) < 0.25)]
        if len(s):
            out[f"ankle_{nm_}_width"] = float(s[:, 0].max() - s[:, 0].min())
            out[f"ankle_{nm_}_depth"] = float(s[:, 1].max() - s[:, 1].min())
        f = v[(v[:, 2] < 0.03) & (v[:, 0] * sd > 0.02) & (np.abs(v[:, 0]) < 0.3)]
        if len(f):
            out[f"foot_{nm_}_length"] = float(f[:, 1].max() - f[:, 1].min())
            out[f"foot_{nm_}_width"] = float(f[:, 0].max() - f[:, 0].min())
        # arm stations along x: centre (y, z), half width (y) and half height (z)
        for k in range(8):
            xs = sd * (0.20 + 0.04 * k)
            w = v[(np.abs(v[:, 0] - xs) < 0.008) & (v[:, 2] > 0.42) & (v[:, 2] < 0.72) & (np.abs(v[:, 1]) < 0.2)]
            if len(w) > 40:
                cy, cz = float(w[:, 1].mean()), float(w[:, 2].mean())
                out[f"arm_{nm_}_x{abs(xs):.2f}"] = [round(cy, 4), round(cz, 4),
                                                    round(float(np.percentile(np.abs(w[:, 1] - cy), 97)), 4),
                                                    round(float(np.percentile(np.abs(w[:, 2] - cz), 97)), 4)]
    out["arm_span"] = float(v[(v[:, 2] > 0.42) & (v[:, 2] < 0.72), 0].max() - v[(v[:, 2] > 0.42) & (v[:, 2] < 0.72), 0].min())
    return out


def diff_table(a, b):
    """compare two measure() dicts: scalars as mm and %, arm stations as per-station mm differences (y, z, half-w, half-h)."""
    rows = {}
    for k, va in a.items():
        vb = b.get(k)
        if vb is None:
            continue
        if isinstance(va, list):
            rows[k] = [round((vb[i] - va[i]) * 1000, 1) for i in range(4)]
        else:
            rows[k] = [round((vb - va) * 1000, 1), round(100 * (vb - va) / va, 1) if va else None]
    return rows


def proportions(v):
    """width : height : depth (x : z : y) of a vertex set, normalised so width = 1, and the size in mm."""
    w, d, h = [float(x) for x in (v.max(0) - v.min(0))]
    return {"size_mm_whd": [round(w * 1000, 1), round(h * 1000, 1), round(d * 1000, 1)],
            "ratio_whd": [1.0, round(h / w, 4), round(d / w, 4)] if w > 0 else None}


def proportion_change_pct(a, b):
    """largest change (percent) in the height/width and depth/width ratios between two proportions() dicts."""
    if not a["ratio_whd"] or not b["ratio_whd"]:
        return None
    return round(max(abs(b["ratio_whd"][i] / a["ratio_whd"][i] - 1) for i in (1, 2)) * 100, 2)


def limb_table(v):
    """position and thickness of each limb along its length, in metres. +X is the character's left.
    arm_L / arm_R: stations along x (0.20 .. 0.48 m from the centre line) of [centre y, centre z, half width (y), half height (z)];
    leg_L / leg_R: stations along z (0.04 .. 0.28 m) of [centre x, centre y, half width (x), half depth (y)]."""
    out = {}
    for sd, nm in ((1, "L"), (-1, "R")):
        arm = []
        for k in range(8):
            x = 0.20 + 0.04 * k
            w = v[(np.abs(v[:, 0] - sd * x) < 0.008) & (v[:, 2] > 0.42) & (v[:, 2] < 0.72) & (np.abs(v[:, 1]) < 0.2)]
            if len(w) > 40:
                cy, cz = float(w[:, 1].mean()), float(w[:, 2].mean())
                arm.append([round(x, 2), cy, cz, float(np.percentile(np.abs(w[:, 1] - cy), 97)), float(np.percentile(np.abs(w[:, 2] - cz), 97))])
        leg = []
        for k in range(7):
            z = 0.04 + 0.04 * k
            w = v[(np.abs(v[:, 2] - z) < 0.008) & (v[:, 0] * sd > 0.01) & (np.abs(v[:, 0]) < 0.25)]
            if len(w) > 40:
                cx, cy = float(w[:, 0].mean()), float(w[:, 1].mean())
                leg.append([round(z, 2), cx, cy, float(np.percentile(np.abs(w[:, 0] - cx), 97)), float(np.percentile(np.abs(w[:, 1] - cy), 97))])
        out["arm_" + nm] = arm
        out["leg_" + nm] = leg
    return out


def limb_compare(ref_v, body_v):
    """body minus reference, per limb station, in mm; plus a per-limb summary (mean position offset and mean thickness change)."""
    tr, tb = limb_table(ref_v), limb_table(body_v)
    res = {}
    for limb in tr:
        rows = []
        br = {r[0]: r for r in tb.get(limb, [])}
        for r in tr[limb]:
            b = br.get(r[0])
            if b is None:
                continue
            rows.append({"at_m": r[0], "ref_mm": [round(x * 1000, 1) for x in r[1:]], "body_mm": [round(x * 1000, 1) for x in b[1:]],
                         "body_minus_ref_mm": [round((b[i] - r[i]) * 1000, 1) for i in range(1, 5)]})
        if rows:
            d = np.array([x["body_minus_ref_mm"] for x in rows])
            t = np.array([x["ref_mm"][2:] for x in rows])
            res[limb] = {"stations": rows,
                         "summary": {"mean_position_offset_mm": [round(float(d[:, 0].mean()), 1), round(float(d[:, 1].mean()), 1)],
                                     "worst_position_offset_mm": round(float(np.hypot(d[:, 0], d[:, 1]).max()), 1),
                                     "mean_thickness_change_pct": [round(float(100 * (d[:, 2] / t[:, 0]).mean()), 1), round(float(100 * (d[:, 3] / t[:, 1]).mean()), 1)]}}
    return res