"""coplanar_audit — READ-ONLY: find surfaces of DIFFERENT pieces that lie on (nearly) the same plane and overlap in area: the places where a render shows z-fighting (flicker, shimmer, a board's colour bleeding through its neighbour). Saves nothing.

params:
  objects        names or globs (required): every mesh among them is taken as evaluated (modifiers applied, as exported), in WORLD space
  against        optional second set of globs: only pairs with one piece in `objects` and the other in `against` are reported (default: pairs inside `objects`)
  dist_tol_m     default 0.001: two triangles are on one plane when every corner of each lies within this distance of the other's plane
  angle_tol_deg  default 0.5: their normals are parallel within this (the absolute dot is used, so back-to-back sheets count)
  min_overlap_m2 default 1e-7: the area where they really overlap, measured in the plane (a shared edge is 0 and is not reported)
  include_opposite true (default): report facing-opposite pairs too (marked `facing: "opposite"`); false drops them and says so in `notes`
  max_pairs      default 300: piece pairs listed, biggest overlap first (all are in out/<name>.json)
  name           file stem of the full list (default coplanar_audit)
Pieces are numbered as `face_orient` numbers them (faces joined through shared vertices, in order of the lowest vertex index), so a pair can be fed straight to `component_transform` / `normals_edit`.
Per reported pair: `faces_a` / `faces_b` (the polygon indices of the faces that overlap, usable in `normals_edit` / `face_remove` `select.faces`; the object is `a.object` / `b.object`), their total area and the share of it that is overlapped (`a_overlapped_share`: 1.0 = the listed faces lie wholly under the other piece), both pieces (object, piece number, faces, world bounds, material names, `gltf_double_sided`), `facing` ("same": z-fighting; "opposite": back to back, visible only through a double-sided material or from the gap), `overlap_area_m2`, `triangle_pairs`, `overlap_bounds_m` (world), `offset_m` (distance of B's surface from A's plane along A's normal: mean, min, max; 0 = exactly coincident), `higher` (the piece whose surface sits further along the shared visible normal: for `same`, the one that normally wins), and a plain-words `reading`.
Limits: it compares triangles of different pieces only (a piece against itself is not looked at); overlap is measured on triangles, so a curved surface that only touches along a line gives nothing; two pieces that are coincident but of very different size are one pair with the overlap area, not the whole; very large sets are refused with a size message (narrow `objects`).
"""
import fnmatch
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402

MAX_OVERLAP = 4_000_000


def pieces_of(me):
    nv = len(me.vertices)
    parent = list(range(nv))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    ed = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", ed)
    for a, b in ed.reshape(-1, 2):
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    lv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", lv)
    has_face = np.zeros(nv, dtype=bool)
    has_face[lv] = True
    num = {}
    out = np.full(nv, -1, dtype=np.int64)
    for v in range(nv):
        if not has_face[v]:
            continue
        r = find(v)
        if r not in num:
            num[r] = len(num)
        out[v] = num[r]
    return out, len(num)


def clip_area(P, Q):
    """Area of the intersection of two convex polygons given as lists of 2D points (counter-clockwise)."""
    out = P
    n = len(Q)
    for i in range(n):
        a, b = Q[i], Q[(i + 1) % n]
        inp, out = out, []
        if not inp:
            break
        for j in range(len(inp)):
            c, d = inp[j], inp[(j + 1) % len(inp)]
            sc = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            sd = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])
            if sc >= 0:
                out.append(c)
            if (sc >= 0) != (sd >= 0):
                t = sc / (sc - sd)
                out.append((c[0] + t * (d[0] - c[0]), c[1] + t * (d[1] - c[1])))
    if len(out) < 3:
        return 0.0, out
    s = 0.0
    for i in range(len(out)):
        x1, y1 = out[i]
        x2, y2 = out[(i + 1) % len(out)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0, out


def main():
    pats = L.param("objects") or []
    if isinstance(pats, str):
        pats = [pats]
    if not pats:
        raise RuntimeError("give `objects` (names or globs)")
    agn = L.param("against") or []
    if isinstance(agn, str):
        agn = [agn]
    tol = float(L.param("dist_tol_m", 0.001))
    cos_t = math.cos(math.radians(float(L.param("angle_tol_deg", 0.5))))
    min_ov = float(L.param("min_overlap_m2", 1e-7))
    incl_opp = bool(L.param("include_opposite", True))
    max_pairs = int(L.param("max_pairs", 300))
    dg = bpy.context.evaluated_depsgraph_get()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH" and (any(fnmatch.fnmatchcase(o.name, p) for p in pats) or any(fnmatch.fnmatchcase(o.name, p) for p in agn))]
    if not objs:
        raise RuntimeError(f"no mesh matches {pats}")
    verts, tris, tri_obj, tri_piece, tri_mat, tri_set, tri_poly = [], [], [], [], [], [], []
    piece_info = {}
    vbase = 0
    for oi, ob in enumerate(objs):
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            nv = len(me.vertices)
            co = np.empty(nv * 3)
            me.vertices.foreach_get("co", co)
            mw = np.array(ev.matrix_world)
            w = (mw[:3, :3] @ co.reshape(-1, 3).T).T + mw[:3, 3]
            nt = len(me.loop_triangles)
            tv = np.empty(nt * 3, dtype=np.int64)
            me.loop_triangles.foreach_get("vertices", tv)
            tp = np.empty(nt, dtype=np.int64)
            me.loop_triangles.foreach_get("polygon_index", tp)
            pid, npieces = pieces_of(me)
            pm = np.array([p.material_index for p in me.polygons], dtype=np.int64)
            mats = [m.name if m else None for m in me.materials]
            dbl = [(not bool(getattr(m, "use_backface_culling", False))) if m else None for m in me.materials]
            tv = tv.reshape(-1, 3)
            neg = np.linalg.det(mw[:3, :3]) < 0
            if neg:
                tv = tv[:, [0, 2, 1]]  # mirrored object: the visible winding is the reverse of the stored one
            verts.append(w)
            tris.append(tv + vbase)
            tri_obj.append(np.full(nt, oi))
            tri_piece.append(pid[tv[:, 0]])
            tri_poly.append(tp)
            tri_mat.append(pm[tp])
            in_objects = any(fnmatch.fnmatchcase(ob.name, p) for p in pats)
            in_against = (not agn and in_objects) or any(fnmatch.fnmatchcase(ob.name, p) for p in agn)
            tri_set.append(np.full(nt, (1 if in_objects else 0) | (2 if in_against else 0)))
            for pc in range(npieces):
                sel = pid[tv[:, 0]] == pc
                if not sel.any():
                    continue
                pv = w[np.unique(tv[sel])]
                pmat = sorted({mats[m] if m < len(mats) else None for m in pm[tp[sel]]}, key=str)
                pdb = [dbl[m] if m < len(dbl) else None for m in sorted(set(pm[tp[sel]]))]
                piece_info[(oi, pc)] = {"object": ob.name, "piece": pc, "faces": int(len(set(tp[sel]))),
                                        "bounds_m": [[round(float(x), 4) for x in pv.min(axis=0)], [round(float(x), 4) for x in pv.max(axis=0)]],
                                        "materials": pmat[:4], "gltf_double_sided": (True if any(pdb) else (False if pdb and all(x is False for x in pdb) else None))}
            vbase += nv
        finally:
            ev.to_mesh_clear()
    V = np.vstack(verts)
    T = np.vstack(tris)
    TO = np.concatenate(tri_obj)
    TP = np.concatenate(tri_piece)
    TS = np.concatenate(tri_set)
    TQ = np.concatenate(tri_poly)
    nT = len(T)
    A, B, C = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    N = np.cross(B - A, C - A)
    ar = np.linalg.norm(N, axis=1) / 2.0
    good = ar > 1e-12
    pkey = TO * 100_000_000 + TQ
    uk, inv = np.unique(pkey, return_inverse=True)
    parea = dict(zip(uk.tolist(), np.bincount(inv, weights=ar).tolist()))
    Nn = np.zeros_like(N)
    Nn[good] = N[good] / (2.0 * ar[good])[:, None]
    # broad phase: boxes grown by the tolerance; a grid of cells (the BVH overlap of mathutils tests real triangle intersection and misses coplanar pairs)
    lo = np.minimum(np.minimum(A, B), C) - tol
    hi = np.maximum(np.maximum(A, B), C) + tol
    ext = (hi - lo).max(axis=1)
    cell = float(max(4.0 * np.median(ext[good]) if good.any() else 0.1, 0.05))
    cells = {}
    big = []
    for t in np.nonzero(good)[0]:
        i0 = np.floor(lo[t] / cell).astype(np.int64)
        i1 = np.floor(hi[t] / cell).astype(np.int64)
        span = (i1 - i0 + 1)
        if span.prod() > 64:
            big.append(int(t))
            continue
        for x in range(i0[0], i1[0] + 1):
            for y in range(i0[1], i1[1] + 1):
                for z in range(i0[2], i1[2] + 1):
                    cells.setdefault((x, y, z), []).append(int(t))
    pr = set()
    for mem in cells.values():
        if len(mem) < 2:
            continue
        m = np.array(mem)
        ii, jj = np.triu_indices(len(m), 1)
        a_, b_ = m[ii], m[jj]
        hit = ((lo[a_] <= hi[b_]).all(axis=1)) & ((lo[b_] <= hi[a_]).all(axis=1))
        for x, y in zip(a_[hit], b_[hit]):
            pr.add((int(min(x, y)), int(max(x, y))))
        if len(pr) > MAX_OVERLAP:
            raise RuntimeError("too many bounding-box overlaps: narrow `objects` (or `against`)")
    for t in big:
        hit = ((lo[t] <= hi).all(axis=1)) & ((lo <= hi[t]).all(axis=1)) & good
        for u_ in np.nonzero(hit)[0]:
            if u_ != t:
                pr.add((int(min(t, u_)), int(max(t, u_))))
    ov = list(pr)
    P = np.array(ov, dtype=np.int64).reshape(-1, 2)
    P = P[P[:, 0] < P[:, 1]]
    key_i = TO[P[:, 0]] * 1_000_000 + TP[P[:, 0]]
    key_j = TO[P[:, 1]] * 1_000_000 + TP[P[:, 1]]
    keep = (key_i != key_j) & good[P[:, 0]] & good[P[:, 1]]
    # which set each side belongs to: with `against`, one side in objects and the other in against
    si, sj = TS[P[:, 0]], TS[P[:, 1]]
    if agn:
        keep &= (((si & 1) > 0) & ((sj & 2) > 0)) | (((sj & 1) > 0) & ((si & 2) > 0))
    else:
        keep &= ((si & 1) > 0) & ((sj & 1) > 0)
    stages = {"bbox_overlaps": int(len(ov)), "different_pieces": int(keep.sum())}
    P = P[keep]
    d = np.einsum("ij,ij->i", Nn[P[:, 0]], Nn[P[:, 1]])
    keep = np.abs(d) >= cos_t
    P, d = P[keep], d[keep]
    stages["parallel"] = int(len(P))
    if len(P):
        i, j = P[:, 0], P[:, 1]
        ok = np.ones(len(P), dtype=bool)
        for X in (A, B, C):
            ok &= np.abs(np.einsum("ij,ij->i", X[j] - A[i], Nn[i])) <= tol
            ok &= np.abs(np.einsum("ij,ij->i", X[i] - A[j], Nn[j])) <= tol
        P, d = P[ok], d[ok]
    stages["within_distance"] = int(len(P))
    pairs = {}
    for (i, j), dot in zip(P, d):
        n = Nn[i]
        u = (B[i] - A[i])
        u = u / np.linalg.norm(u)
        v = np.cross(n, u)

        def poly(k):
            pts = [(float(np.dot(X[k] - A[i], u)), float(np.dot(X[k] - A[i], v))) for X in (A, B, C)]
            s = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
            return pts if s > 0 else pts[::-1]
        area, outp = clip_area(poly(i), poly(j))
        if area < min_ov:
            continue
        facing = "same" if dot > 0 else "opposite"
        if facing == "opposite" and not incl_opp:
            continue
        ka = (int(TO[i]), int(TP[i]))
        kb = (int(TO[j]), int(TP[j]))
        if (ka, kb) not in pairs and (kb, ka) in pairs:
            ka, kb = kb, ka
            i, j = j, i
            n = Nn[i]
        rec = pairs.setdefault((ka, kb), {"area": 0.0, "n": 0, "off": [], "facing": set(), "lo": np.full(3, np.inf), "hi": np.full(3, -np.inf), "nsum": np.zeros(3), "fa": set(), "fb": set()})
        rec["area"] += area
        rec["fa"].add(int(TQ[i]))
        rec["fb"].add(int(TQ[j]))
        rec["n"] += 1
        rec["facing"].add(facing)
        cj = (A[j] + B[j] + C[j]) / 3.0
        rec["off"].append(float(np.dot(cj - A[i], n)))
        rec["nsum"] += n * area
        for (px, py) in outp:
            w3 = A[i] + u * px + v * py
            rec["lo"] = np.minimum(rec["lo"], w3)
            rec["hi"] = np.maximum(rec["hi"], w3)
    rows = []
    for (ka, kb), r in pairs.items():
        off = np.array(r["off"])
        fac = "same" if r["facing"] == {"same"} else ("opposite" if r["facing"] == {"opposite"} else "both")
        mean_off = float(off.mean())
        if fac == "same":
            higher = "B" if mean_off > 0 else ("A" if mean_off < 0 else "neither (exactly coincident)")
            reading = f"{'exactly coincident' if abs(mean_off) < 1e-6 else f'{abs(mean_off) * 1000:.2f} mm apart'}, same facing, overlap {r['area']:.5f} m2: z-fighting where they overlap"
        elif fac == "opposite":
            higher = "n/a"
            reading = f"back to back, {abs(mean_off) * 1000:.2f} mm apart, overlap {r['area']:.5f} m2: shows only through a double-sided material or from a gap"
        else:
            higher = "mixed"
            reading = f"both same-facing and opposite-facing triangles overlap ({r['area']:.5f} m2): read the triangle pairs"
        fa, fb = sorted(r["fa"]), sorted(r["fb"])
        aa = sum(parea.get(ka[0] * 100_000_000 + f, 0.0) for f in fa)
        ab = sum(parea.get(kb[0] * 100_000_000 + f, 0.0) for f in fb)
        rows.append({"faces_a": fa, "faces_b": fb, "a_face_area_m2": round(aa, 6), "b_face_area_m2": round(ab, 6),
                     "a_overlapped_share": round(min(1.0, r["area"] / aa), 4) if aa else None, "b_overlapped_share": round(min(1.0, r["area"] / ab), 4) if ab else None,
                     "a": piece_info[ka], "b": piece_info[kb], "facing": fac, "overlap_area_m2": round(r["area"], 6), "triangle_pairs": r["n"],
                     "overlap_bounds_m": [[round(float(x), 4) for x in r["lo"]], [round(float(x), 4) for x in r["hi"]]],
                     "offset_m": {"mean": round(mean_off, 6), "min": round(float(off.min()), 6), "max": round(float(off.max()), 6)},
                     "higher": higher, "reading": reading})
    rows.sort(key=lambda x: -x["overlap_area_m2"])
    name = L.param("name", "coplanar_audit")
    outd = L.ARGS.get("out_dir")
    full = None
    if outd:
        os.makedirs(outd, exist_ok=True)
        full = os.path.join(outd, name + ".json")
        with open(full, "w", encoding="utf-8") as fh:
            json.dump(rows, fh)
    by_obj = {}
    for r in rows:
        for s in ("a", "b"):
            by_obj[r[s]["object"]] = by_obj.get(r[s]["object"], 0) + 1
    notes = ["read-only; triangles of the SAME piece are never compared"]
    if not incl_opp:
        notes.append("opposite-facing (back to back) pairs were excluded (include_opposite false)")
    L.finish({"objects": len(objs), "triangles": int(nT), "bbox_overlaps_tested": int(len(ov)), "piece_pairs": len(rows),
              "same_facing_pairs": sum(1 for r in rows if r["facing"] == "same"), "opposite_facing_pairs": sum(1 for r in rows if r["facing"] == "opposite"),
              "total_overlap_m2": round(sum(r["overlap_area_m2"] for r in rows), 5), "pairs_by_object": by_obj,
              "stages": stages, "dist_tol_m": tol, "angle_tol_deg": float(L.param("angle_tol_deg", 0.5)), "min_overlap_m2": min_ov, "listed": min(max_pairs, len(rows)),
              "full_list_file": full, "notes": notes},
             save=False, pairs=rows[:max_pairs])


L.run(main)
