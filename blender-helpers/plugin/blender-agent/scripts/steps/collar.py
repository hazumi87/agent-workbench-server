"""collar — make a separate padded COLLAR mesh around the neck of a head + torso pair, to hide the join between them without touching either. Saves a checkpoint (not with dry_run).

HEAD and TORSO are only read: their vertices are hashed before and after and the report says `untouched`. The collar is one closed, welded, low-poly mesh named `name` (default COLLAR), made new from the numbers below (a later call with the same name rebuilds it from new numbers; an object of that name that this verb did not make is never replaced).
Shape: a padded ring. The collar sits on the seam PLANE (fitted to the seam points, so a head tilted on the torso gives a tilted collar; its normal is the neck axis). The INNER wall follows the real outline: at each height along the axis the outline is cut from the meshes (first surface met going out from the centre; `outline_from`), moved out by `clearance_mm`, smoothed round the ring; so it is as oval as the neck is. The top is a rounded rim (`rim_round`), higher at the back than the front (`rim_front_mm` / `rim_rear_mm` above the seam, a smooth cosine blend between), and the rim is lowered wherever it would come nearer than `jaw_clear_mm` to HEAD. The bottom edge sinks `sink_mm` into the TORSO surface under it and follows its slope (it flares over the shoulders), reaching at most `below_mm` under the seam.
The seam is the line where HEAD meets TORSO: HEAD vertices within `seam_tol_mm` of the TORSO surface (or give `seam_z_mm`, metres x1000, to set its height).
Frame: the scene's world frame, Z up, the character faces -Y (rear = +Y); all numbers in mm.

params:
  head, torso      object names (default "HEAD", "TORSO")
  name             collar object (default "COLLAR")
  thickness_mm     padding thickness, inner wall to outer wall (default 16)
  clearance_mm     gap between the neck and the inner wall (default 4)
  rim_front_mm     rim height above the seam at the front (default 12)
  rim_rear_mm      rim height above the seam at the rear (default 40)
  rim_shape        how fast the height rises from front to rear: 1 = plain cosine (default), >1 stays low longer, <1 rises sooner
  rim_round        0..1 how round the top is (1 = a full half-circle, default 0.8)
  below_mm         most the collar reaches under the seam (default 20)
  sink_mm          how far the bottom edge sinks into the torso (default 3)
  jaw_clear_mm     smallest allowed distance rim - HEAD (default 6)
  segments         vertices round the ring (default 48, a multiple of 4)
  smooth           0..1 how much the inner outline is smoothed round the ring (default 0.5)
  conform          true / "head" (default): any collar vertex inside HEAD is moved out to 2 mm beyond the head surface (the collar then bulges round a jaw instead of cutting through it); "both": the same for TORSO on every vertex but the bottom edge (the collar then rides over a raised garment instead of being buried in it); false: none. The report counts the moved vertices.
  outline_hull     true (default): each outline is replaced by its convex envelope, so hair tufts and notches are bridged and the inner wall does not trace them
  seat_reach_mm    the bottom edge follows the TORSO surface down, at most this far under the seam plane (default 60), so the lower edge stays seated in the garment all the way round; where no torso is found it hangs below_mm under the seam. seat_tol_mm (default 4): how far above the surface still counts as seated; the report's clearance.base_contact lists every floating point count and the 8 worst angles
  shift_max_mm     most a ring angle may be moved outward (default 25) so that a tall rim clears HEAD instead of being cut down: the smallest move that works is used, angle by angle, and reported as moved_out_mm
  fit_max_mm       most the outward fit (HEAD, and TORSO with conform "both", inside the padding) may move one ring angle in total (default 60); what is still inside then is reported, not hidden
  rim_smooth       passes of rim-height smoothing round the ring (default 6; never raises the rim above what the jaw allows): more = a rounder, lower-detail rim edge
  tint             true (default): pictures colour HEAD green, TORSO blue and the collar brown, so every grey-looking patch can be told apart; false: the plain clay colours
  outline_from     what the inner wall follows: "head" (default: HEAD's outline at each height; TORSO's where HEAD is not cut), "torso", or "both" (the larger of the two)
  seam_tol_mm      HEAD points this close to TORSO make the seam (default 2); seam_z_mm moves the collar along the neck axis from the seam plane (default 0)
  pose_pivot_mm    height above the seam of the turning point for pose_tests (default 0)
  pose_tests       rigid HEAD turns used only to measure clearance (the head is turned in memory and put back; not rig validation): list of {"name", "yaw", "pitch", "roll"} degrees about the neck centre at the seam (yaw about Z, pitch about X, roll about Y); default nod +20 / -15, turn 40, tilt 15. [] = none
  views            pictures: list of names from front, back, left, right, three_quarter, under_chin, rear_high, neck_close, bust (default all), res px (default 640)
  dry_run          true: nothing is saved and the collar is removed again; the numbers and pictures are the preview
Returns: seam (height, point count, centre), the inner outline (radii front/side/rear, mm), the rim heights and where the jaw limited them, dimensions, triangles, topology (closed, non-manifold edges, flipped), clearance (neck gap min/median/max, rim to head min, collar vertices inside HEAD, deepest dip into TORSO), seam coverage (share of seam points under the collar, smallest margin to the rim and the bottom), pose test table, `untouched` for HEAD/TORSO, pictures, limitations.
"""
import hashlib
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402
import _handview as HV  # noqa: E402

MM = 0.001
BINS = 96


def world_tris(o):
    me = o.data
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    P = co.reshape(-1, 3)
    M = np.array(o.matrix_world)
    P = P @ M[:3, :3].T + M[:3, 3]
    me.calc_loop_triangles()
    T = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", T)
    return P, T.reshape(-1, 3)


def vhash(o):
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get("co", co)
    return hashlib.sha1(co.astype(np.float64).tobytes()).hexdigest()[:16] + f":{len(o.data.vertices)}:{np.array(o.matrix_world).round(9).tobytes().hex()[:12]}"


def sub_bvh(P, T, keep_vertex):
    """BVH of the triangles that have a vertex where keep_vertex is true (the part of a big mesh near the neck); the search never builds a tree of millions of triangles"""
    m = keep_vertex[T].any(axis=1)
    Ts = T[m]
    used, inv = np.unique(Ts, return_inverse=True)
    Pl = [tuple(p) for p in P[used]]
    return BVHTree.FromPolygons(Pl, [tuple(t) for t in inv.reshape(-1, 3)]), int(m.sum())


def first_exit(pts, centre, n=BINS):
    """nearest outline radius per angular bin (the first surface met going out from the centre), holes filled by interpolation round the ring"""
    q = pts - centre
    a = np.arctan2(q[:, 1], q[:, 0])
    r = np.hypot(q[:, 0], q[:, 1])
    idx = np.clip(((a + np.pi) / (2 * np.pi) * n).astype(int), 0, n - 1)
    rad = np.full(n, np.nan)
    for k in range(n):
        m = idx == k
        if m.any():
            rad[k] = r[m].min()
    ok = ~np.isnan(rad)
    if ok.sum() < 8:
        return None
    x = np.arange(n)
    rad = np.interp(x, x[ok], rad[ok], period=n)
    return rad


def hull_ring(r, ang):
    """the convex envelope of an outline given as radii at angles `ang`: lobes (hair tufts, notches) are bridged, the outline never gets smaller"""
    pts = sorted(zip((r * np.cos(ang)).tolist(), (r * np.sin(ang)).tolist()))
    def half(ps):
        h = []
        for q in ps:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (q[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (q[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(q)
        return h
    lower, upper = half(pts), half(pts[::-1])
    poly = np.array(lower[:-1] + upper[:-1])
    out = np.array(r, dtype=float)
    n = len(poly)
    for k, a in enumerate(ang):
        d = np.array([math.cos(a), math.sin(a)])
        best = out[k]
        for m in range(n):
            p0, p1 = poly[m], poly[(m + 1) % n]
            e = p1 - p0
            den = d[0] * e[1] - d[1] * e[0]
            if abs(den) < 1e-12:
                continue
            t = (p0[0] * e[1] - p0[1] * e[0]) / den
            u = (p0[0] * d[1] - p0[1] * d[0]) / den
            if t > 0 and -1e-9 <= u <= 1 + 1e-9:
                best = t
        out[k] = max(best, r[k])
    return out


def smooth_ring(r, amount):
    """circular blur of a radius ring; amount 0..1 -> kernel half-width up to n/8"""
    n = len(r)
    w = int(round(amount * n / 8))
    if w < 1:
        return r
    k = np.hanning(2 * w + 3)[1:-1]
    k /= k.sum()
    ext = np.concatenate([r[-w:], r, r[:w]])
    return np.convolve(ext, k, mode="valid")


def inside(bvh, p, margin=0.0):
    loc, n_, _, d = bvh.find_nearest(Vector(p))
    return loc is not None and n_ is not None and (Vector(p) - loc).dot(n_) < -margin


def cut_points(P, T, z, c, rmax=0.15):
    """xy points where the triangle edges cross the plane Z = z, within rmax of c"""
    s = P[:, 2] - z
    out = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        sa, sb = s[T[:, a]], s[T[:, b]]
        m = (sa * sb) < 0
        if m.any():
            ia, ib = T[m, a], T[m, b]
            t = (sa[m] / (sa[m] - sb[m]))[:, None]
            out.append((P[ia] + (P[ib] - P[ia]) * t)[:, :2])
    pts = np.concatenate(out) if out else np.zeros((0, 2))
    return pts[np.hypot(pts[:, 0] - c[0], pts[:, 1] - c[1]) < rmax]


ARC = 6
PROF_N = 2 * ARC + 5


def profile(h_total, thick, rr):
    """cross-section points (d outward from the inner wall, u up from the bottom): inner bottom, inner wall middle, the rounded rim over to the outer wall, outer bottom. PROF_N points; the rim arcs are indexes 2 .. 2*ARC+3"""
    top = h_total
    pts = [(0.0, 0.0), (0.0, (top - rr) / 2)]
    for k in range(ARC + 1):
        a = math.pi - (math.pi / 2) * k / ARC
        pts.append((rr + rr * math.cos(a), top - rr + rr * math.sin(a)))
    for k in range(ARC + 1):
        a = (math.pi / 2) - (math.pi / 2) * k / ARC
        pts.append((thick - rr + rr * math.cos(a), top - rr + rr * math.sin(a)))
    pts.append((thick, 0.0))
    return pts


def sections_picture(HP, HT, TP, TT, centre, rad_at, ang, clr, V, res, path, levels_mm=(-20, 0, 20, 40), span=0.30):
    """four cuts perpendicular to the neck axis (heights in mm along it, 0 = the seam plane): HEAD edge crossings orange, TORSO blue, the centre as a white cross, the inner wall of the collar (neck outline + clearance) green, the collar's own cut yellow; north in each cut = the rear"""
    cell = max(240, res // 2)
    img = np.zeros((cell * 2, cell * 2, 4), dtype=np.float32)
    img[..., :3] = 0.12
    img[..., 3] = 1.0

    def dot(c, x, y, col):
        px = int((x - centre[0]) / span * cell + cell / 2)
        py = int((y - centre[1]) / span * cell + cell / 2)
        if 0 <= px < cell and 0 <= py < cell:
            r0, c0 = (c // 2) * cell, (c % 2) * cell
            img[r0 + py, c0 + px, :3] = col

    for c, lv in enumerate(levels_mm):
        z = lv * MM
        for P, T, col in ((HP, HT, (1.0, 0.55, 0.1)), (TP, TT, (0.3, 0.55, 1.0))):
            zt = P[:, 2][T]
            Ts = T[(zt.max(axis=1) >= z) & (zt.min(axis=1) <= z)]
            for x, y in cut_points(P, Ts, z, centre[:2], rmax=span / 2):
                dot(c, x, y, col)
        for th in np.linspace(-np.pi, np.pi, 180, endpoint=False):
            r = float(rad_at(th, z)) + clr
            dot(c, centre[0] + r * math.cos(th), centre[1] + r * math.sin(th), (0.2, 0.9, 0.3))
        Vs = V.reshape(-1, 3)
        Vt = V.reshape(-1, V.shape[1], 3)
        for i in range(V.shape[0]):
            for j in range(V.shape[1] - 1):
                a_, b_ = Vt[i, j], Vt[i, j + 1]
                if min(a_[2], b_[2]) <= z <= max(a_[2], b_[2]) and abs(a_[2] - b_[2]) > 1e-9:
                    f = (z - a_[2]) / (b_[2] - a_[2])
                    dot(c, a_[0] + f * (b_[0] - a_[0]), a_[1] + f * (b_[1] - a_[1]), (1.0, 0.95, 0.2))
        for d in range(-4, 5):
            dot(c, centre[0] + d * 0.0005, centre[1], (1, 1, 1))
            dot(c, centre[0], centre[1] + d * 0.0005, (1, 1, 1))
    im = bpy.data.images.new("collar-sections", cell * 2, cell * 2, alpha=True)
    im.pixels = img[::-1].ravel().tolist()
    im.filepath_raw = path
    im.file_format = "PNG"
    im.save()
    bpy.data.images.remove(im)
    return path


def main():
    hn, tn = L.param("head", "HEAD"), L.param("torso", "TORSO")
    name = L.param("name", "COLLAR")
    dry = bool(L.param("dry_run", False))
    thick = float(L.param("thickness_mm", 16)) * MM
    clr = float(L.param("clearance_mm", 4)) * MM
    hf = float(L.param("rim_front_mm", 12)) * MM
    hr = float(L.param("rim_rear_mm", 40)) * MM
    shape = float(L.param("rim_shape", 1.0))
    rround = max(0.0, min(1.0, float(L.param("rim_round", 0.8))))
    below = float(L.param("below_mm", 20)) * MM
    sink = float(L.param("sink_mm", 3)) * MM
    jaw = float(L.param("jaw_clear_mm", 6)) * MM
    N = max(12, int(L.param("segments", 48)) // 4 * 4)
    sm = float(L.param("smooth", 0.5))
    outline_from = L.param("outline_from", "head")
    conform = L.param("conform", True)
    if conform not in (True, False, "head", "both"):
        raise RuntimeError('conform must be true, false, "head" or "both"')
    hull = bool(L.param("outline_hull", True))
    rim_passes = int(L.param("rim_smooth", 6))
    shift_max = float(L.param("shift_max_mm", 25)) * MM
    fit_cap = float(L.param("fit_max_mm", 60)) * MM
    seat_reach = float(L.param("seat_reach_mm", 60)) * MM
    if outline_from not in ("head", "torso", "both"):
        raise RuntimeError("outline_from must be head, torso or both")
    stol = float(L.param("seam_tol_mm", 2)) * MM
    rr = max(0.002, min(thick / 2 - 0.0005, rround * thick / 2))
    head, torso = bpy.data.objects.get(hn), bpy.data.objects.get(tn)
    if head is None or torso is None or head.type != "MESH" or torso.type != "MESH":
        raise RuntimeError(f"collar needs two meshes named {hn} and {tn}; the scene has {[o.name for o in L.meshes()]}")
    ex = bpy.data.objects.get(name)
    if ex is not None and "collar_made" not in ex:
        raise RuntimeError(f"an object named {name} exists and was not made by collar: choose another `name` (it is never replaced)")
    h_before, t_before = vhash(head), vhash(torso)
    HP, HT = world_tris(head)
    TP, TT = world_tris(torso)

    # ---- seam: HEAD vertices that touch the TORSO surface (looked for in the lowest 10 cm of HEAD)
    hz0 = float(HP[:, 2].min())
    near_t = (TP[:, 2] > hz0 - 0.2) & (TP[:, 2] < hz0 + 0.25) & (np.hypot(TP[:, 0] - HP[:, 0].mean(), TP[:, 1] - HP[:, 1].mean()) < 0.35)
    tb, _ = sub_bvh(TP, TT, near_t)
    low = np.where(HP[:, 2] < hz0 + 0.10)[0]
    seam_pts = []
    for i in low:
        loc, nrm, _, d = tb.find_nearest(Vector(HP[i]))
        if loc is not None and d <= stol:
            seam_pts.append(HP[i])
    seam_pts = np.array(seam_pts)
    # ---- the seam plane: a robust plane through the seam points; its normal (toward the head) is the neck axis, so a head that sits tilted on the torso gets a tilted collar
    seam_note = None
    if len(seam_pts) >= 6:
        inl = np.ones(len(seam_pts), dtype=bool)
        for _ in range(4):
            o_w = seam_pts[inl].mean(0)
            _u, _s, Vt = np.linalg.svd(seam_pts[inl] - o_w, full_matrices=False)
            w_w = Vt[2]
            dist = np.abs((seam_pts - o_w) @ w_w)
            thr = max(0.004, 2.5 * float(np.median(dist[inl])))
            new_inl = dist < thr
            if new_inl.sum() < 6:
                break
            inl = new_inl
        o_w = seam_pts[inl].mean(0)
        plane_rms = float(np.sqrt(np.mean(((seam_pts[inl] - o_w) @ w_w) ** 2)))
        n_inl = int(inl.sum())
    else:
        o_w = np.array([HP[:, 0].mean(), HP[:, 1].mean(), hz0 + 0.01])
        w_w, plane_rms, n_inl = np.array([0.0, 0.0, 1.0]), 0.0, 0
        seam_note = "HEAD never touches TORSO within seam_tol_mm: the seam was taken as a horizontal plane 10 mm above the head's lowest point (give seam_z_mm / seam_tol_mm)"
    if (HP.mean(0) - o_w) @ w_w < 0:
        w_w = -w_w
    if L.param("seam_z_mm") is not None:
        o_w = o_w + w_w * float(L.param("seam_z_mm")) * MM
    rear = np.array([0.0, 1.0, 0.0]) - w_w * w_w[1]
    rear /= np.linalg.norm(rear)
    xl = np.cross(rear, w_w)
    B = np.stack([xl, rear, w_w], axis=1)  # columns: local X (left-right), Y (rear), Z (neck axis); local = (world - o) @ B
    HP = (HP - o_w) @ B
    TP = (TP - o_w) @ B
    seam_pts = (seam_pts - o_w) @ B if len(seam_pts) else seam_pts
    seam_z = 0.0
    ring_pts = seam_pts[np.abs(seam_pts[:, 2]) < 0.03] if len(seam_pts) else np.zeros((0, 3))
    c0 = np.array([0.0, 0.0])
    tilt = float(np.degrees(np.arccos(max(-1.0, min(1.0, w_w[2])))))

    # ---- the triangles near the neck, for the cuts and the distance searches
    z_lo, z_hi = seam_z - max(below, seat_reach) - 0.02, seam_z + max(hf, hr) + 0.03
    def window(P, T):
        zt = P[:, 2][T]
        return T[(zt.max(axis=1) >= z_lo) & (zt.min(axis=1) <= z_hi)]

    HT_w, TT_w = window(HP, HT), window(TP, TT)
    zlist = np.linspace(z_lo, z_hi, 15)
    MAXGROW = 0.015  # the inner wall never grows more than this beyond its radius at the seam, whatever the torso does under the collar

    def outlines_about(c):
        """per height: the neck outline = the larger of the first surfaces met going out from the centre in HEAD and in TORSO (the collar must clear both), None where neither is cut"""
        res = []
        for z in zlist:
            rs = {}
            for key, P, T in (("head", HP, HT_w), ("torso", TP, TT_w)):
                pts = cut_points(P, T, z, c)
                r = first_exit(pts, c) if len(pts) > 12 else None
                if r is not None:
                    rs[key] = hull_ring(r, ang) if hull else r
            if outline_from == "both":
                use = list(rs.values())
            else:  # the named part when it is cut at this height, else the other one
                use = [rs[outline_from]] if outline_from in rs else list(rs.values())
            res.append(np.maximum.reduce(use) if use else None)
        base = res[int(np.argmin(np.abs(zlist - seam_z)))]
        if base is not None:
            res = [None if r is None else np.minimum(r, base + MAXGROW) for r in res]
        return res

    ang = (np.arange(BINS) + 0.5) / BINS * 2 * np.pi - np.pi
    outlines = outlines_about(c0)
    good = [i for i, r in enumerate(outlines) if r is not None]
    if len(good) < 3:
        raise RuntimeError("could not cut a neck outline from HEAD + TORSO near the seam: check the head and torso names and that Z is up (give seam_z_mm if the seam is not found)")
    iz = min(good, key=lambda i: abs(zlist[i] - seam_z))
    c1 = c0
    for _ in range(4):  # move the centre to the middle of the outline at the seam, and cut again
        r_ = outlines[iz]
        c1 = c1 + np.array([np.mean(r_ * np.cos(ang)), np.mean(r_ * np.sin(ang))])
        outlines = outlines_about(c1)
        good = [i for i, r in enumerate(outlines) if r is not None]
        if iz not in good:
            raise RuntimeError("the neck outline at the seam was lost while centring: give seam_z_mm or axis")

    centre = np.array([c1[0], c1[1], seam_z])
    zz = np.array([zlist[i] for i in good])
    RR = np.array([smooth_ring(outlines[i], sm) for i in good])

    def rad_at(theta, z):
        j = int(np.clip(np.searchsorted(zz, z) - 1, 0, len(zz) - 2))
        f = float(np.clip((z - zz[j]) / (zz[j + 1] - zz[j]), 0, 1))
        return np.interp(theta, ang, RR[j] * (1 - f) + RR[j + 1] * f, period=2 * np.pi)

    # BVHs of the neighbourhood (within 0.3 m of the neck centre) for distances
    near_h = np.hypot(HP[:, 0] - centre[0], HP[:, 1] - centre[1]) < 0.3
    near_h &= np.abs(HP[:, 2] - seam_z) < 0.3
    hb, nh_tris = sub_bvh(HP, HT, near_h)
    # HEAD without its own neck skin (what lies within 2 mm of the neck outline at the heights of the collar): the jaw, chin and hair the rim must keep clear of
    hz = HP[:, 2]
    hth = np.arctan2(HP[:, 1] - centre[1], HP[:, 0] - centre[0])
    hr_ = np.hypot(HP[:, 0] - centre[0], HP[:, 1] - centre[1])
    jl = np.clip(np.searchsorted(zz, hz) - 1, 0, len(zz) - 1)
    RIM_J = [j for j, (d_, u_) in enumerate(profile(0.05, thick, rr)) if j >= 2 and d_ >= 0.3 * thick]
    skin = np.zeros(len(HP), dtype=bool)
    idx = np.where(near_h & (hz > z_lo - 0.01))[0]
    for k in idx:
        skin[k] = hr_[k] <= float(np.interp(hth[k], ang, RR[jl[k]], period=2 * np.pi)) + 0.002
    keep_j = near_h & ~skin
    hbj, _ = sub_bvh(HP, HT[~skin[HT].all(axis=1)], keep_j)
    near_t = np.hypot(TP[:, 0] - centre[0], TP[:, 1] - centre[1]) < 0.3
    near_t &= np.abs(TP[:, 2] - seam_z) < 0.3
    tb, nt_tris = sub_bvh(TP, TT, near_t)

    # ---- ring angles: ring angle 0 = front (-Y); world angle atan2(y, x)
    th = np.arange(N) / N * 2 * np.pi
    wang = (-np.pi / 2 + th + np.pi) % (2 * np.pi) - np.pi
    rim = hf + (hr - hf) * ((1 - np.cos(th)) / 2) ** shape

    def ring_points(i, h, shift=0.0):
        c, s_ = math.cos(wang[i]), math.sin(wang[i])
        out = []
        for (d, u) in profile(below + h, thick, rr):
            z = seam_z - below + u
            rin = float(rad_at(wang[i], z)) + clr + shift
            out.append(np.array([centre[0] + c * (rin + d), centre[1] + s_ * (rin + d), z]))
        return out

    # at each angle find the tallest rim (down from the wanted height) that clears HEAD by jaw_clear after moving that angle outward by at most shift_max_mm (the smallest move that works): a tall back that stands a little further out instead of a rim cut down to 8 mm
    h_used = np.zeros(N)
    pre_shift = np.zeros(N)
    limited = 0
    limiter = {}
    steps_s = [0.0] + [k * 0.003 for k in range(1, int(shift_max / 0.003) + 1)]

    def clear_at(i, h, sh):
        for p in [ring_points(i, h, sh)[j] for j in RIM_J]:
            loc, n_, _, d_ = hbj.find_nearest(Vector(p))
            if loc is not None and (d_ < jaw or (n_ is not None and (Vector(p) - loc).dot(n_) < 0)):
                return (loc, d_)
        return None
    for i in range(N):
        h = float(rim[i])
        last_bad, chosen = None, None
        while chosen is None:
            for sh in steps_s:
                bad = clear_at(i, h, sh)
                if bad is None:
                    chosen = (h, sh)
                    break
                last_bad = bad
            if chosen is None:
                if h <= 0.008:
                    chosen = (0.008, 0.0)
                else:
                    h = max(0.008, h - 0.002)
        h, sh = chosen
        if h < rim[i] - 1e-6 or sh > 0:
            if h < rim[i] - 1e-6:
                limited += 1
            lb = last_bad[0] if last_bad else None
            limiter[i] = {"ring_angle_deg": round(float(np.degrees(th[i])), 1), "wanted_mm": round(float(rim[i]) / MM, 1), "allowed_mm": round(h / MM, 1), "moved_out_mm": round(sh / MM, 1)}
            if lb is not None:
                limiter[i]["head_point"] = {"radius_from_axis_mm": round(float(np.hypot(lb.x - centre[0], lb.y - centre[1])) / MM, 1), "height_above_seam_mm": round(float(lb.z) / MM, 1), "distance_mm": round(float(last_bad[1]) / MM, 1)}
        h_used[i] = h
        pre_shift[i] = sh
    for _ in range(3):  # neighbours follow, so the outward moves blend
        pre_shift = np.maximum(pre_shift, 0.85 * np.maximum(np.roll(pre_shift, 1), np.roll(pre_shift, -1)))
    k3 = np.array([0.25, 0.5, 0.25])
    for _ in range(max(1, rim_passes)):  # smooth round the ring, never above what the jaw allowed: a rounded rim, not one that traces every lobe
        h_used = np.minimum(h_used, np.convolve(np.concatenate([h_used[-1:], h_used, h_used[:1]]), k3, mode="valid"))

    V = np.array([ring_points(i, float(h_used[i]), float(pre_shift[i])) for i in range(N)])
    floor_z = seam_z - below  # where the bottom edge hangs when there is no torso under it
    for i in range(N):
        for j in (0, PROF_N - 1):
            p = V[i, j]
            loc, _n, _, _d = tb.ray_cast(Vector((p[0], p[1], seam_z + 0.06)), Vector((0, 0, -1)), 0.06 + seat_reach + 0.03)  # the bottom edge follows the torso surface down, at most seat_reach under the seam plane
            z = max(loc.z - sink, seam_z - seat_reach) if loc is not None else floor_z
            V[i, j, 2] = min(z, V[i, 2, 2] - 0.003)
        V[i, 1, 2] = (V[i, 0, 2] + V[i, 2, 2]) / 2

    # ---- conform: any collar vertex that ended up inside HEAD (a jaw, hair or cheek bulging into the collar's space) is moved out to 2 mm outside the head surface
    pushed, maxpush = 0, 0.0
    if conform:
        moved = np.zeros(V.shape[:2], dtype=bool)
        for _ in range(4):
            changed = False
            for i in range(N):
                for j in range(PROF_N):
                    p = Vector(V[i, j])
                    for bv_, on in ((hb, True), (tb, conform == "both" and 0 < j < PROF_N - 1)):  # TORSO: not the bottom edge, which is meant to sink into it
                        if not on:
                            continue
                        loc, n_, _, d = bv_.find_nearest(p)
                        if loc is not None and n_ is not None and (p - loc).dot(n_) < 0:
                            q = loc + n_ * 0.002
                            maxpush = max(maxpush, (q - p).length)
                            V[i, j] = np.array(q)
                            p = Vector(V[i, j])
                            moved[i, j] = True
                            changed = True
            if not changed:
                break
        pushed = int(moved.sum())

    # ---- fit outside: HEAD (and with conform "both" TORSO above the bottom edge) surface that still lies inside the padding moves that ring angle outward (the whole cross-section, radially) until it is outside, 2 mm clear
    fit_shift = np.zeros(N)
    if conform:
        Hn0 = (np.hypot(HP[:, 0] - centre[0], HP[:, 1] - centre[1]) < 0.25) & (np.abs(HP[:, 2]) < 0.2)
        Tn0 = (np.hypot(TP[:, 0] - centre[0], TP[:, 1] - centre[1]) < 0.25) & (np.abs(TP[:, 2]) < 0.2)
        sets = [(HP, Hn0, None)] + ([(TP, Tn0, "torso")] if conform == "both" else [])
        for _ in range(4):
            polys_ = [np.stack([np.hypot(V[i, :, 0] - centre[0], V[i, :, 1] - centre[1]), V[i, :, 2]], axis=1) for i in range(N)]
            need = np.zeros(N)
            for P, near, kind in sets:
                ids = np.where(near)[0]
                q = P[ids]
                a_ = (np.arctan2(q[:, 1] - centre[1], q[:, 0] - centre[0]) - (-np.pi / 2)) % (2 * np.pi)
                ring = np.round(a_ / (2 * np.pi) * N).astype(int) % N
                rr_ = np.hypot(q[:, 0] - centre[0], q[:, 1] - centre[1])
                for i in np.unique(ring):
                    m = ring == i
                    pts = np.stack([rr_[m], q[m, 2]], axis=1)
                    poly = polys_[i]
                    if kind == "torso":  # the bottom edge is meant to sink into TORSO: only what is above it counts
                        keep = pts[:, 1] > float(poly[:, 1].min()) + sink + 0.004
                        pts = pts[keep]
                        if not len(pts):
                            continue
                    inb = np.zeros(len(pts), dtype=bool)
                    xleft = np.full(len(pts), np.inf)
                    for k in range(len(poly)):
                        x0, y0 = poly[k]
                        x1, y1 = poly[(k + 1) % len(poly)]
                        st = (y0 > pts[:, 1]) != (y1 > pts[:, 1])
                        xc = x0 + (pts[:, 1] - y0) * (x1 - x0) / (y1 - y0 + 1e-18)
                        inb ^= st & (pts[:, 0] < xc)
                        xleft = np.where(st, np.minimum(xleft, xc), xleft)
                    if inb.any():
                        need[i] = max(need[i], float((pts[inb, 0] - xleft[inb]).max()) + 0.002)
            need = np.minimum(need, np.maximum(fit_cap - fit_shift, 0.0))
            if need.max() <= 0:
                break
            need = np.maximum(need, np.convolve(np.concatenate([need[-1:], need, need[:1]]), np.array([0.5, 1.0, 0.5]) / 1.0 * 0 + np.array([0.0, 1.0, 0.0]), mode="valid"))
            for _s in range(2):  # spread to the neighbours so the collar does not kink
                need = np.maximum(need, 0.8 * np.roll(need, 1), )
                need = np.maximum(need, 0.8 * np.roll(need, -1))
            for i in range(N):
                if need[i] > 0:
                    d_ = np.array([math.cos(wang[i]), math.sin(wang[i]), 0.0])
                    V[i, :, :] += d_ * need[i]
            fit_shift += need
    # ---- mesh
    Vw = V @ B.T + o_w
    bm = bmesh.new()
    bv = [[bm.verts.new(Vector(Vw[i, j])) for j in range(PROF_N)] for i in range(N)]
    for i in range(N):
        i2 = (i + 1) % N
        for j in range(PROF_N):
            j2 = (j + 1) % PROF_N
            bm.faces.new([bv[i][j], bv[i2][j], bv[i2][j2], bv[i][j2]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    cen = Vector(tuple(centre @ B.T + o_w))
    w_v = Vector(tuple(w_w))
    outer = [f for f in bm.faces if abs(f.normal.dot(w_v)) < 0.3]
    vote = sum(1 for f in outer if (f.calc_center_median() - cen - w_v * (f.calc_center_median() - cen).dot(w_v)).dot(f.normal) > 0)
    if outer and vote < len(outer) / 2:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if ex is not None:
        old = ex.data
        ex.data = me
        bpy.data.meshes.remove(old)
        col_obj = ex
    else:
        col_obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(col_obj)
    me.name = name
    for p in me.polygons:
        p.use_smooth = True
    me.update()
    mat = bpy.data.materials.get("collar-pad")
    if mat is None:
        mat = bpy.data.materials.new("collar-pad")
        mat.diffuse_color = (0.55, 0.28, 0.12, 1)
        mat.use_nodes = True
        b = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if b:
            b.inputs["Base Color"].default_value = (0.55, 0.28, 0.12, 1)
    me.materials.clear()
    me.materials.append(mat)
    col_obj["collar_made"] = True

    # ---- measurements
    CP = V.reshape(-1, 3)
    bm2 = bmesh.new()
    bm2.from_mesh(me)
    nm_e = sum(1 for e in bm2.edges if len(e.link_faces) != 2)
    bm2.free()

    gaps = []
    for i in range(N):
        p = Vector(V[i, 1])
        gaps.append(min(x for x in (hb.find_nearest(p)[3], tb.find_nearest(p)[3]) if x is not None))
    gaps = np.array(gaps)
    rim_d = [d for i in range(N) for d in [hbj.find_nearest(Vector(V[i, j]))[3] for j in RIM_J] if d is not None]
    base = []  # signed height of each bottom-edge point above the torso surface under it (+ = floating above it, - = sunk into it)
    for i in range(N):
        for j, side in ((0, "inner"), (PROF_N - 1, "outer")):
            p = Vector(V[i, j])
            loc, n_, _, d_ = tb.find_nearest(p)
            sg = 1.0 if (loc is None or n_ is None or (p - loc).dot(n_) >= 0) else -1.0
            base.append((i, side, sg * (d_ if d_ is not None else 1e9)))
    bvals = np.array([b[2] for b in base])
    worst = sorted(base, key=lambda b: -b[2])[:8]
    seat_tol = float(L.param("seat_tol_mm", 4)) * MM
    base_contact = {"inner_median_mm": round(float(np.median([b[2] for b in base if b[1] == "inner"])) / MM, 1), "outer_median_mm": round(float(np.median([b[2] for b in base if b[1] == "outer"])) / MM, 1),
                    "max_floating_mm": round(float(bvals.max()) / MM, 1), "points_floating_over_tol": int((bvals > seat_tol).sum()), "of_points": len(base), "tol_mm": round(seat_tol / MM, 1),
                    "worst": [{"ring_angle_deg": round(float(np.degrees(th[b[0]])), 1), "edge": b[1], "floating_mm": round(float(b[2]) / MM, 1)} for b in worst],
                    "note": "the bottom edge is set sink_mm into the torso surface (about -3 mm); floating = how far above that surface a point of the lower edge is. Ring angle 0 = front, 180 = rear"}
    bot_d = np.array([tb.find_nearest(Vector(V[i, j]))[3] for i in range(N) for j in (0, PROF_N - 1)], dtype=float)
    in_head = sum(1 for p in CP if inside(hb, p, 1e-4))
    dip = 0.0
    for p in CP:
        if inside(tb, p):
            dip = max(dip, tb.find_nearest(Vector(p))[3])
    cov = None
    if len(ring_pts):
        cnt, mtop, mbot = 0, 1e9, 1e9
        for p in ring_pts:
            a = math.atan2(p[1] - centre[1], p[0] - centre[0])
            i = int(round(((a + math.pi / 2) % (2 * math.pi)) / (2 * math.pi) * N)) % N
            top = float(V[i, 2:2 + 2 * ARC + 2, 2].max())
            bot = float(V[i, 0, 2])
            cnt += bot <= p[2] <= top
            mtop, mbot = min(mtop, top - p[2]), min(mbot, p[2] - bot)
        cov = {"seam_points": int(len(ring_pts)), "covered_pct": round(100.0 * cnt / len(ring_pts), 1), "min_margin_to_rim_mm": round(mtop / MM, 1), "min_margin_to_bottom_mm": round(mbot / MM, 1)}

    # measured intersections (not appearance): triangles that cross a surface, and surface points that stick through the collar's solid
    Ct = []
    for i in range(N):
        i2 = (i + 1) % N
        for j in range(PROF_N):
            j2 = (j + 1) % PROF_N
            a_, b_, c_, d_ = i * PROF_N + j, i2 * PROF_N + j, i2 * PROF_N + j2, i * PROF_N + j2
            Ct += [(a_, b_, c_), (a_, c_, d_)]
    cbv = BVHTree.FromPolygons([tuple(v) for v in V.reshape(-1, 3)], Ct)
    # winding of these triangles is not relied on: `sgn` is decided with a point known to be inside the padding
    polys = []
    for i in range(N):
        polys.append(np.stack([np.hypot(V[i, :, 0] - centre[0], V[i, :, 1] - centre[1]), V[i, :, 2]], axis=1))

    by_ring = {}
    ids_in = []

    def inside_counts(P, near):
        """vertices of P that lie inside the collar's padding: each is tested in the (radius, height) cross-section of the nearest ring angle; (count, deepest in mm)"""
        ids = np.where(near)[0]
        q = P[ids]
        a_ = (np.arctan2(q[:, 1] - centre[1], q[:, 0] - centre[0]) - (-np.pi / 2)) % (2 * np.pi)
        ring = np.round(a_ / (2 * np.pi) * N).astype(int) % N
        rr_ = np.hypot(q[:, 0] - centre[0], q[:, 1] - centre[1])
        cnt, deep = 0, 0.0
        by_ring.clear()
        ids_in.clear()
        for i in np.unique(ring):
            m = ring == i
            pts = np.stack([rr_[m], q[m, 2]], axis=1)
            poly = polys[i]
            inside = np.zeros(len(pts), dtype=bool)
            dmin = np.full(len(pts), 1e9)
            for k in range(len(poly)):
                x0, y0 = poly[k]
                x1, y1 = poly[(k + 1) % len(poly)]
                cond = ((y0 > pts[:, 1]) != (y1 > pts[:, 1])) & (pts[:, 0] < (x1 - x0) * (pts[:, 1] - y0) / (y1 - y0 + 1e-18) + x0)
                inside ^= cond
                e = np.array([x1 - x0, y1 - y0])
                t = np.clip(((pts - [x0, y0]) @ e) / max(float(e @ e), 1e-18), 0, 1)
                dmin = np.minimum(dmin, np.hypot(*(pts - ([x0, y0] + t[:, None] * e)).T))
            cnt += int(inside.sum())
            if inside.any():
                ids_in.append(ids[m][inside])
                deep = max(deep, float(dmin[inside].max()))
                by_ring[int(i)] = {"ring_angle_deg": round(float(np.degrees(th[i])), 1), "count": int(inside.sum()), "deepest_mm": round(float(dmin[inside].max()) / MM, 1), "highest_point_above_seam_mm": round(float(pts[inside, 1].max()) / MM, 1)}
        return cnt, deep

    def count_inside(P, near):
        return inside_counts(P, near)

    Hn = np.hypot(HP[:, 0] - centre[0], HP[:, 1] - centre[1]) < 0.25
    Hn &= np.abs(HP[:, 2]) < 0.2
    Tn_ = np.hypot(TP[:, 0] - centre[0], TP[:, 1] - centre[1]) < 0.25
    Tn_ &= np.abs(TP[:, 2]) < 0.2
    h_in, h_mx = count_inside(HP, Hn)
    h_by = sorted(by_ring.values(), key=lambda d: -d["count"])[:8]
    t_in, t_mx = count_inside(TP, Tn_)
    t_ids = np.concatenate(ids_in) if ids_in else np.zeros(0, dtype=int)
    t_by = sorted(by_ring.values(), key=lambda d: -d["count"])[:8]
    hb_full, _ = sub_bvh(HP, HT, Hn)
    tb_full, _ = sub_bvh(TP, TT, Tn_)
    x_head = sorted({a for a, b in cbv.overlap(hb_full)})
    x_torso = sorted({a for a, b in cbv.overlap(tb_full)})
    xs_ = {"collar_triangles_crossing_head": len(x_head), "collar_triangles_crossing_torso": len(x_torso), "head_vertices_inside_collar": h_in, "head_inside_collar_max_mm": round(h_mx / MM, 1),
           "head_inside_by_angle": h_by, "torso_inside_by_angle": t_by, "torso_vertices_inside_collar": t_in, "torso_inside_collar_max_mm": round(t_mx / MM, 1), "of_collar_triangles": len(Ct),
           "note": "the bottom edge is meant to sink into TORSO (sink_mm), so triangles crossing TORSO there are expected; torso vertices inside the collar are surface that sticks through its visible walls"}
    poses = L.param("pose_tests")
    if poses is None:
        poses = [{"name": "nod_down_20", "pitch": 20}, {"name": "nod_up_15", "pitch": -15}, {"name": "turn_40", "yaw": 40}, {"name": "tilt_15", "roll": 15}]
    prow = []
    if poses:
        pivot = np.array([centre[0], centre[1], centre[2] + float(L.param("pose_pivot_mm", 0)) * MM])
        Tn = HT[(near_h & ~skin)[HT].any(axis=1) & ~skin[HT].all(axis=1)]
        used, inv = np.unique(Tn, return_inverse=True)
        Tl = [tuple(t) for t in inv.reshape(-1, 3)]
    for pz in poses:
        R = np.array(Matrix.Rotation(math.radians(float(pz.get("yaw", 0))), 3, "Z") @ Matrix.Rotation(math.radians(float(pz.get("pitch", 0))), 3, "X") @ Matrix.Rotation(math.radians(float(pz.get("roll", 0))), 3, "Y"))
        P2 = (HP[used] - pivot) @ R.T + pivot
        hb2 = BVHTree.FromPolygons([tuple(p) for p in P2], Tl)
        dmin = min((hb2.find_nearest(Vector(p))[3] or 1e9) for p in CP)
        nin = sum(1 for p in CP if inside(hb2, p, 1e-4))
        prow.append({"name": pz.get("name", "pose"), "yaw": pz.get("yaw", 0), "pitch": pz.get("pitch", 0), "roll": pz.get("roll", 0), "min_distance_head_to_collar_mm": round(dmin / MM, 1), "collar_vertices_inside_head": int(nin), "clear": nin == 0})

    rseam = rad_at(ang, seam_z)

    def at(wa):
        return round(float(np.interp(wa, ang, rseam, period=2 * np.pi)) / MM, 1)
    outline = {"front_mm": at(-np.pi / 2), "rear_mm": at(np.pi / 2), "side_plus_x_mm": at(0.0), "side_minus_x_mm": at(np.pi), "centre_m": [round(float(x), 4) for x in (centre @ B.T + o_w)]}
    lo, hi = Vw.reshape(-1, 3).min(0), Vw.reshape(-1, 3).max(0)
    # envelope table: per 30-degree sector round the neck axis, how low HEAD reaches and how high TORSO reaches, in mm above the seam plane (the plane fitted through the seam); a lower neckline seat has to sit below the first and the torso's own collar must not rise above it
    env = []
    ra = np.hypot(HP[:, 0] - centre[0], HP[:, 1] - centre[1])
    rb = np.hypot(TP[:, 0] - centre[0], TP[:, 1] - centre[1])
    aa = (np.degrees(np.arctan2(HP[:, 1] - centre[1], HP[:, 0] - centre[0])) + 90) % 360
    ab = (np.degrees(np.arctan2(TP[:, 1] - centre[1], TP[:, 0] - centre[0])) + 90) % 360
    for k in range(12):
        a0, a1 = k * 30.0, (k + 1) * 30.0
        mh = (aa >= a0) & (aa < a1) & (ra > 0.03) & (ra < 0.16) & (np.abs(HP[:, 2]) < 0.12)
        mt = (ab >= a0) & (ab < a1) & (rb > 0.03) & (rb < 0.16) & (np.abs(TP[:, 2]) < 0.12)
        row = {"ring_angle_deg": [a0, a1]}
        if mh.any():
            j = int(np.argmin(np.where(mh, HP[:, 2], 9.0)))
            row["head_lowest_mm"] = round(float(HP[j, 2]) / MM, 1)
            row["head_lowest_radius_mm"] = round(float(ra[j]) / MM, 1)
        mt2 = mt & (rb < 0.16)
        if mt2.any():
            j = int(np.argmax(np.where(mt2, TP[:, 2], -9.0)))
            row["torso_highest_within_160mm_mm"] = round(float(TP[j, 2]) / MM, 1)
            row["torso_highest_radius_mm"] = round(float(rb[j]) / MM, 1)
        env.append(row)
    tris = len(me.polygons)
    untouched = (h_before == vhash(head)) and (t_before == vhash(torso))

    # ---- pictures
    names = L.param("views") or ["front", "back", "left", "right", "three_quarter", "under_chin", "rear_high", "neck_close", "bust", "sections", "back_close", "left_close", "right_close", "mask"]
    res = int(L.param("res", 640))
    cvec = Vector(tuple(centre @ B.T + o_w)) + Vector(tuple(w_w * 0.02))
    dirs_neck = {"front": (0, -1, 0.15), "back": (0, 1, 0.15), "left": (1, 0, 0.1), "right": (-1, 0, 0.1), "three_quarter": (-0.7, -0.7, 0.3)}
    files = []
    shown = [head, torso, col_obj]
    tint = bool(L.param("tint", True))
    saved_colors = [(o, tuple(o.color)) for o in shown]
    if tint:
        head.color, torso.color, col_obj.color = (0.62, 0.78, 0.62, 1), (0.62, 0.70, 0.88, 1), (0.60, 0.30, 0.12, 1)
    ctype = "OBJECT" if tint else "MATERIAL"
    vw = Vector(tuple(w_w))
    close = {k: v for k, v in dirs_neck.items() if k in names}
    if close:
        files += HV.render_views(shown, cvec, 0.45, "collar-neck", res=res, dirs=close, color_type=ctype)
    offs = {}
    if "under_chin" in names:
        offs["under_chin"] = [0.0, -0.32, -0.12]
    if "rear_high" in names:
        offs["rear_high"] = [0.0, 0.34, 0.26]
    if "neck_close" in names:
        offs["neck_close"] = [-0.14, -0.2, 0.06]
    if "back_close" in names:
        offs["back_close"] = [0.0, 0.2, 0.07]
    if "left_close" in names:
        offs["left_close"] = [0.2, 0.0, 0.06]
    if "right_close" in names:
        offs["right_close"] = [-0.2, 0.0, 0.06]
    if offs:
        files += HV.render_views(shown, cvec, 0.45, "collar-cam", res=res, cam_offsets=offs, fov_deg=38, color_type=ctype)
    if "mask" in names and len(t_ids):
        # the TORSO surface that lies inside the collar's padding (the old garment collar), in red on the torso near the neck: a preview of what a bounded hidden edit would have to change; nothing is edited
        near_t2 = np.zeros(len(TP), dtype=bool)
        near_t2[:] = (np.hypot(TP[:, 0] - centre[0], TP[:, 1] - centre[1]) < 0.22) & (np.abs(TP[:, 2]) < 0.2)
        mk = np.zeros(len(TP), dtype=bool)
        mk[t_ids] = True
        Tsel = TT[near_t2[TT].any(axis=1)]
        used, inv = np.unique(Tsel, return_inverse=True)
        Wp = TP[used] @ B.T + o_w
        mesh2 = bpy.data.meshes.new("collar-mask")
        mesh2.from_pydata([tuple(v) for v in Wp], [], [tuple(t) for t in inv.reshape(-1, 3)])
        redm, bluem = bpy.data.materials.new("mk-red"), bpy.data.materials.new("mk-blue")
        redm.diffuse_color, bluem.diffuse_color = (0.95, 0.15, 0.15, 1), (0.62, 0.70, 0.88, 1)
        mesh2.materials.append(bluem)
        mesh2.materials.append(redm)
        fm = mk[Tsel].any(axis=1)
        mesh2.polygons.foreach_set("material_index", fm.astype(np.int32))
        mo = bpy.data.objects.new("collar-mask", mesh2)
        bpy.context.scene.collection.objects.link(mo)
        mask_area = float(np.sum(np.linalg.norm(np.cross(TP[Tsel[fm][:, 1]] - TP[Tsel[fm][:, 0]], TP[Tsel[fm][:, 2]] - TP[Tsel[fm][:, 0]]), axis=1)) / 2) if fm.any() else 0.0
        for ob in (head, torso):
            ob.hide_render = True
        files += HV.render_views([mo, col_obj], cvec, 0.45, "collar-mask", res=res, cam_offsets={"back": [0.0, 0.2, 0.09], "left": [0.2, 0.0, 0.06], "right": [-0.2, 0.0, 0.06], "front": [0.0, -0.22, 0.08]}, fov_deg=36, color_type="MATERIAL")
        for ob in (head, torso):
            ob.hide_render = False
        bpy.data.objects.remove(mo, do_unlink=True)
        bpy.data.meshes.remove(mesh2)
        xs_["torso_mask"] = {"vertices": int(len(t_ids)), "faces": int(fm.sum()), "area_mm2": round(mask_area * 1e6, 1), "pictures": "collar-mask-{back,left,right,front}.png: torso near the neck, the faces to change in red, the collar brown; HEAD hidden. A preview only: nothing in TORSO is edited"}
    if "bust" in names:
        bb_lo, bb_hi = L.world_bbox([head, torso])
        bc = (bb_lo + bb_hi) / 2
        files += HV.render_views(shown, bc, max(bb_hi.x - bb_lo.x, bb_hi.z - bb_lo.z) * 1.15, "collar-bust", res=res, dirs={"front": (0, -1, 0.1), "back": (0, 1, 0.1)}, color_type=ctype)
    for o, c_ in saved_colors:
        o.color = c_
    if "sections" in names:
        files.append(sections_picture(HP, HT, TP, TT, centre, rad_at, ang, clr, V, res, os.path.join(L.ARGS["out_dir"], "collar-sections.png")))
    summary = {"collar": name, "triangles": tris, "dry_run": dry, "untouched": untouched}
    report = {
        "seam": {"centre_m": [round(float(x), 4) for x in o_w], "axis_world": [round(float(x), 3) for x in w_w], "tilt_from_vertical_deg": round(tilt, 1), "points": int(len(seam_pts)), "plane_points": n_inl, "plane_rms_mm": round(plane_rms / MM, 2), "note": seam_note},
        "inner_outline_at_seam": outline,
        "conform": {"on": conform, "vertices_pushed_out_of_head": pushed, "largest_push_mm": round(maxpush / MM, 1), "fit_outside_angles": int((fit_shift > 0).sum()), "fit_outside_max_shift_mm": round(float(fit_shift.max()) / MM, 1), "moved_out_by_limiter_max_mm": round(float(pre_shift.max()) / MM, 1)},
        "rim": {"front_mm": round(float(h_used[0]) / MM, 1), "rear_mm": round(float(h_used[N // 2]) / MM, 1), "angles_lowered_by_jaw": int(limited), "of": N},
        "dimensions_mm": {"width": round(float(hi[0] - lo[0]) / MM, 1), "depth": round(float(hi[1] - lo[1]) / MM, 1), "height": round(float(hi[2] - lo[2]) / MM, 1), "thickness": round(thick / MM, 1)},
        "topology": {"vertices": len(me.vertices), "triangles": tris, "boundary_or_nonmanifold_edges": nm_e, "closed": nm_e == 0},
        "clearance": {"neck_gap_min_mm": round(float(gaps.min()) / MM, 1), "neck_gap_median_mm": round(float(np.median(gaps)) / MM, 1), "neck_gap_max_mm": round(float(gaps.max()) / MM, 1),
                      "rim_to_head_min_mm": round(float(min(rim_d)) / MM, 1) if rim_d else None, "collar_vertices_inside_head": int(in_head), "deepest_dip_into_torso_mm": round(dip / MM, 1), "base_contact": base_contact,
                      "bottom_edge_to_torso_median_mm": round(float(np.median(bot_d)) / MM, 1), "bottom_edge_to_torso_max_mm": round(float(bot_d.max()) / MM, 1)},
        "head_torso_envelope": env, "seam_coverage": cov, "intersections": xs_, "rim_limited_by": list(limiter.values()), "pose_tests": prow,
        "limitations": ["the inner wall follows the neck outline cut from the meshes at 15 heights (first surface out from the neck centre); an undercut such as a chin over the neck or hair hanging onto it counts as neck where it touches it",
                        "the rim is lowered where it would come nearer than jaw_clear_mm to HEAD in the rest pose; pose tests are rigid turns of HEAD (its own neck skin left out, since a real neck bends) about the neck centre at the seam, or `pose_pivot_mm` above it (clearance numbers, not rig validation): the collar is one rigid mesh and does not deform with the neck",
                        "the collar is untextured: one flat material `collar-pad`, no UVs"],
        "pictures": [os.path.basename(f) for f in files]}
    if dry:
        bpy.data.objects.remove(col_obj, do_unlink=True)
    L.finish(summary, save=not dry, files={os.path.basename(f): f for f in files}, **report)


L.run(main)
