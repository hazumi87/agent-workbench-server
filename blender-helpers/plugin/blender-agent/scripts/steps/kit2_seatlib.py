"""kit2_seatlib — the contact face of a mounted part against its host, and a rigid seating of the part on it. Imported by kit2_contact and kit2_seat; not a verb.

The contact face is the same one kit2_part's `touch` check measures: every sampled vertex of the part within `reach` of the host that has a clear line
to the nearest host point (nothing of the part in between), so the far side of the part is left out. The gap is the distance from that vertex to the
host's surface. The same 4000 samples are used, so the numbers agree with kit2_part's.
"""
import numpy as np
from mathutils import Matrix, Vector

import kit2_common as K


class Hosts:
    """several host objects as one surface: find_nearest gives the nearest point of any of them (the part sits on the strap AND the chest under it)"""

    def __init__(self, objs):
        self.bvhs = [K.bvh_of(h) for h in objs]

    def find_nearest(self, P):
        best = (None, None, None, 1e30)
        for b in self.bvhs:
            r = b.find_nearest(P)
            if r[0] is not None and r[3] < best[3]:
                best = r
        return best


def hosts_of(spec):
    """the host objects named by `host` (a name or a list of names) as one surface"""
    import bpy
    names = spec if isinstance(spec, list) else [spec]
    objs = []
    for n in names:
        h = bpy.data.objects.get(n or "")
        if h is None or h.type != "MESH":
            raise RuntimeError(f"host: no mesh named {n}")
        objs.append(h)
    if not objs:
        raise RuntimeError("host is required")
    return objs, Hosts(objs)


def pairs(o, host_bvh, reach=0.04, n=4000):
    """(vertex array, vertex normals, [(index, host point, host normal, gap)]) for the contact face of `o`"""
    V = K.verts(o)
    k = min(n, len(V))
    idx = np.random.default_rng(2).choice(len(V), k, replace=False)
    nr = np.empty(len(V) * 3)
    o.data.vertices.foreach_get("normal", nr)
    N = nr.reshape(-1, 3)
    part_bvh = K.bvh_of(o)
    out = []
    for i in idx:
        P = Vector(V[i])
        loc, nrm, _, dist = host_bvh.find_nearest(P)
        if loc is None or dist > reach:
            continue
        d = loc - P
        if dist > 2e-4 and part_bvh.ray_cast(P + d.normalized() * 1e-4, d.normalized(), dist - 2e-4)[0] is not None:
            continue
        out.append((int(i), np.array(loc), np.array(nrm), float(dist)))
    return V, N, out


def stats(V, N, prs):
    """gap numbers over the contact face, like kit2_part's touch check, plus how far the face is from parallel to the host"""
    if not prs:
        return {"n_contact_points": 0, "median_gap_mm": None, "worst_gap_mm": None, "max_gap_mm": None, "min_gap_mm": None, "face_tilt_deg": None}
    g = np.array([p[3] for p in prs])
    # how far the face as a whole is from lying flat on the host: the mean normal of the contact face against the mean host normal under it (0 = parallel)
    npart = np.zeros(3)
    nhost = np.zeros(3)
    for i, _, nh, _ in prs:
        npart += N[i]
        nhost += np.sign(float(N[i] @ nh) or 1.0) * np.asarray(nh)
    a, b = np.linalg.norm(npart), np.linalg.norm(nhost)
    tilt = round(float(np.degrees(np.arccos(max(-1.0, min(1.0, float(npart @ nhost) / (a * b)))))), 1) if a > 1e-9 and b > 1e-9 else None
    return {"n_contact_points": int(len(g)), "median_gap_mm": K.mm(np.median(g)), "worst_gap_mm": K.mm(np.percentile(g, 95)), "max_gap_mm": K.mm(g.max()),
            "min_gap_mm": K.mm(g.min()), "face_tilt_deg": tilt}


def gate(st, med_lim=6.0, worst_lim=20.0, min_points=20):
    """the touch check's verdict on stats(): (ok, reasons)"""
    why = []
    if st["n_contact_points"] < min_points:
        why.append(f"only {st['n_contact_points']} points of its face toward the host are in reach: it does not touch")
    else:
        if st["median_gap_mm"] > med_lim:
            why.append(f"median gap {st['median_gap_mm']} mm over {med_lim}")
        if st["worst_gap_mm"] > worst_lim:
            why.append(f"worst (95th percentile) gap {st['worst_gap_mm']} mm over {worst_lim}")
    return (not why), why


def kabsch(P, T):
    """the rotation R and translation t with R @ p + t closest to t_i in the least-squares sense (no scale): (R, t)"""
    cp, ct = P.mean(0), T.mean(0)
    H = (P - cp).T @ (T - ct)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T)) or 1.0
    R = Vt.T @ np.diag([1, 1, d]) @ U.T
    return R, ct - R @ cp


def angle_axis(R):
    c = (np.trace(R) - 1) / 2
    a = float(np.degrees(np.arccos(max(-1.0, min(1.0, c)))))
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    n = np.linalg.norm(w)
    return a, (w / n if n > 1e-9 else np.array([0.0, 0.0, 1.0]))


def seat(o, host_bvh, reach=0.04, sink=0.003, iters=30, rotate=True, trim=0.7):
    """rigidly move `o` (rotation + translation, no scaling, no change of shape) so its contact face lies on the host: ICP on the contact face, each
    point aimed at its nearest host point pushed `sink` metres on through the surface. The part's vertices are changed in place.
    Returns (R, t, iterations, converged): the part ended at R @ x + t for every starting vertex x."""
    V0 = K.verts(o).copy()
    R_tot, t_tot = np.eye(3), np.zeros(3)
    done, conv = 0, False
    for it in range(iters):
        V, N, prs = pairs(o, host_bvh, reach)
        if len(prs) < 20:
            break
        P = np.array([V[i] for i, *_ in prs])
        Q = np.array([q for _, q, _, _ in prs])
        D = Q - P
        dist = np.linalg.norm(D, axis=1)
        dirn = np.where(dist[:, None] > 1e-5, D / np.maximum(dist[:, None], 1e-9), 0.0)
        T = Q + dirn * sink
        keep = np.argsort(np.linalg.norm(T - P, axis=1))[: max(20, int(trim * len(P)))]
        if rotate:
            R, t = kabsch(P[keep], T[keep])
        else:
            R, t = np.eye(3), (T[keep] - P[keep]).mean(0)
        R_tot, t_tot = R @ R_tot, R @ t_tot + t
        K.set_verts(o, V @ R.T + t)
        done = it + 1
        if np.linalg.norm(t) < 5e-5 and angle_axis(R)[0] < 0.02:
            conv = True
            break
    return R_tot, t_tot, done, conv, V0


def euler_deg(R):
    return [round(float(x), 1) for x in np.degrees(Matrix(R.tolist()).to_euler("XYZ"))]
