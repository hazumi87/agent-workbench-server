"""kit2_bodyedit — change the HIDDEN body under a named rigid part, never the part. Saves a checkpoint (unless dry_run).

Use it when body skin shows through, or pokes out of, a rigid part (a cuff, a plate): the part stays as it is and the body
surface under it is pushed inward, or the body faces buried deep inside the part are removed.

Eligibility (the safety rule): only body vertices UNDER the part may change. A body vertex is under the part when its outward
normal ray hits the part (covered), or when it pokes through: the outward ray misses but the inward ray hits the part within
poke_mm. Every other vertex, and every face with a vertex that is not covered, is never touched. The step checks this at the
end and fails if anything else moved.

params:
  part       object name of the rigid part (required)
  mode       "relief" (push the body surface inward) or "remove" (delete buried body faces)
  body       object name of the body (default body.001 if present, else body)
  margin_mm  relief: how far inside the part's inner surface the body surface must end up (default 4)
  max_mm     relief: no vertex moves more than this (default 30); vertices that would need more are counted as capped
  smooth_mm  relief: neighbouring eligible vertices share their moves within this distance so the surface stays smooth (default 12)
  blend_mm   relief: width of a feather band just OUTSIDE the part's rim (default 0 = off, at most 40). Body vertices within this
             distance of a covered vertex move too, by the nearby covered moves times a smooth falloff to 0 at the band's edge, and
             the band is then smoothed over the mesh. Use it when the body is much thicker than the part's opening, so the body
             would otherwise step down at the rim. It is the only way anything outside the part may move.
  depth_mm   remove: delete faces whose centre is at least this deep below the part's inner surface (default 10)
  reach_mm   outward ray length (default 150);  poke_mm  inward ray length (default 40)
  box        optional {c:[x,y,z], size:[x,y,z]} metres: only vertices/faces inside this box can change
  dry_run    true = report only, change nothing, save nothing
Returns: eligible vertices (covered / poking), how many moved and by how much, the show-through before and after, faces removed,
body checks, `moved_outside_eligible` (the vertices outside the part that moved: 0 unless blend_mm > 0, then only the feather band),
`moved_outside_allowed_zone` (must be 0), and with blend_mm: `blend` (vertices moved in the band, largest move, mesh slope of the
displacement in the band and under the part, before and after blending).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import math  # noqa: E402
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def classify(bvh, pts, nrm, reach, poke):
    """per point: state 0 outside the part, 1 covered, 2 poking through; plus the move needed (m) to end up inside by margin-free depth:
    d_out (distance outward to the part, covered) and e_in / e_in2 (distance inward to the part's first and second hit, poking)."""
    n = len(pts)
    state = np.zeros(n, dtype=np.int8)
    d_out = np.zeros(n)
    e1 = np.zeros(n)
    e2 = np.zeros(n)
    for i in range(n):
        nv = Vector(nrm[i])
        p = Vector(pts[i])
        h = bvh.ray_cast(p + nv * 1e-4, nv, reach)
        if h[0] is not None:
            state[i], d_out[i] = 1, h[3]
            continue
        h = bvh.ray_cast(p - nv * 1e-4, -nv, poke)
        if h[0] is not None:
            state[i], e1[i] = 2, h[3]
            h2 = bvh.ray_cast(h[0] - nv * 1e-4, -nv, reach)  # the next surface of the part further in (its inner wall)
            e2[i] = h2[3] + h[3] if h2[0] is not None else h[3]
    return state, d_out, e1, e2


def edge_slope(me, bv, move, eligible):
    """steepness of the displacement across mesh edges that touch a moved vertex: |difference in move| / edge length (mm per mm).
    visible_zone = edges with an end outside the part (what you can see), under_part = both ends under the part."""
    e = np.empty(len(me.edges) * 2, dtype=int)
    me.edges.foreach_get("vertices", e)
    a, b = e.reshape(-1, 2).T
    ln = np.maximum(np.linalg.norm(bv[a] - bv[b], axis=1), 1e-6)
    sl = np.abs(move[a] - move[b]) / ln
    touched = (move[a] > 5e-4) | (move[b] > 5e-4)
    out = {}
    for nm, m in (("visible_zone", touched & (~eligible[a] | ~eligible[b])), ("under_part", touched & eligible[a] & eligible[b])):
        out[nm] = {"edges": int(m.sum()), "p95": round(float(np.percentile(sl[m], 95)), 2) if m.any() else 0.0, "max": round(float(sl[m].max()), 2) if m.any() else 0.0}
    return out


def feather(bv, me, eligible, move, blend, cap, lo, hi):
    """spread the covered vertices' moves outward over a band of `blend` metres with a cosine falloff, then smooth the band."""
    e_idx = np.flatnonzero(eligible)
    etree = K.kd(bv[e_idx])
    cand = np.flatnonzero(np.all((bv >= lo - blend) & (bv <= hi + blend), axis=1) & ~eligible)
    band = np.zeros(len(bv), dtype=bool)
    fm = np.zeros(len(bv))
    for i in cand:
        near = etree.find_range(bv[i], blend)
        if not near:
            continue
        d = np.array([x[2] for x in near])
        mv = np.array([move[e_idx[x[1]]] for x in near])
        w = 1.0 / (d + 0.003)
        fm[i] = float((w * mv).sum() / w.sum()) * 0.5 * (1 + math.cos(math.pi * float(d.min()) / blend))
        band[i] = True
    e = np.empty(len(me.edges) * 2, dtype=int)
    me.edges.foreach_get("vertices", e)
    adj = {}
    for a, b in e.reshape(-1, 2):
        if band[a] or band[b]:
            adj.setdefault(int(a), []).append(int(b))
            adj.setdefault(int(b), []).append(int(a))
    m = move.copy()
    m[band] = fm[band]
    bi = np.flatnonzero(band)
    for _ in range(6):  # the covered vertices stay fixed; the band relaxes toward its neighbours
        nxt = m.copy()
        for i in bi:
            nb = adj.get(int(i))
            if nb:
                nxt[i] = 0.5 * m[i] + 0.5 * float(np.mean(m[nb]))
        m = nxt
    m = np.minimum(m, cap)
    m[~(eligible | band)] = 0.0
    return m, band


def main():
    part = bpy.data.objects[L.param("part")]
    mode = L.param("mode")
    if mode not in ("relief", "remove"):
        raise RuntimeError('mode must be "relief" or "remove"')
    bname = L.param("body") or ("body.001" if "body.001" in bpy.data.objects else "body")
    body = bpy.data.objects[bname]
    me = body.data
    bv = K.verts(body)
    nrm = np.empty(len(bv) * 3)
    me.vertex_normals.foreach_get("vector", nrm)
    nrm = nrm.reshape(-1, 3)
    pv = K.verts(part)
    box = L.param("box")
    lo, hi = (np.array(box["c"]) - np.array(box["size"]) / 2, np.array(box["c"]) + np.array(box["size"]) / 2) if box else (pv.min(0), pv.max(0))
    cand = np.flatnonzero(np.all((bv >= lo) & (bv <= hi), axis=1))
    if len(cand) == 0:
        raise RuntimeError("refused: no body vertex lies under this part (wrong part name or box)")
    bvh = K.bvh_of(part)
    reach, poke = float(L.param("reach_mm", 150)) / 1000, float(L.param("poke_mm", 40)) / 1000
    state_c, d_out, e1, e2 = classify(bvh, bv[cand], nrm[cand], reach, poke)
    state = np.zeros(len(bv), dtype=np.int8)
    state[cand] = state_c
    eligible = state > 0
    n_cov, n_vis = int((state == 1).sum()), int((state == 2).sum())
    if not eligible.any():
        raise RuntimeError("refused: no body vertex is covered by, or pokes through, this part")
    rep = {"part": part.name, "body": bname, "mode": mode, "eligible_covered": n_cov, "eligible_poking": n_vis,
           "show_through_before_pct": round(100 * n_vis / max(1, n_cov + n_vis), 1), "dry_run": bool(L.param("dry_run", False))}
    before = bv.copy()

    if mode == "relief":
        margin, cap = float(L.param("margin_mm", 4)) / 1000, float(L.param("max_mm", 30)) / 1000
        need = np.zeros(len(bv))
        # covered: it must end up at least `margin` below the part's inner surface (d_out = distance to that surface)
        idx_all = np.flatnonzero(eligible)
        need[cand[state_c == 1]] = np.maximum(0.0, margin - d_out[state_c == 1])
        # poking: it must go past the part's inner surface (e2) and then `margin` further
        need[cand[state_c == 2]] = e2[state_c == 2] + margin
        e_idx = idx_all
        tree = K.kd(bv[e_idx])
        r = float(L.param("smooth_mm", 12)) / 1000
        mx = np.array([max(need[e_idx[j]] for (_, j, _) in tree.find_range(bv[i], r)) for i in e_idx])
        sm = np.array([float(np.mean([mx[j] for (_, j, _) in tree.find_range(bv[i], r / 2)])) for i in e_idx])
        move = np.zeros(len(bv))
        move[e_idx] = np.maximum(sm, need[e_idx])  # smooth, but never less than the vertex itself needs
        capped = int((move > cap).sum())
        move = np.minimum(move, cap)
        blend = min(float(L.param("blend_mm", 0)), 40.0) / 1000
        band = np.zeros(len(bv), dtype=bool)
        slope_before = edge_slope(me, bv, move, eligible) if blend > 0 else None
        if blend > 0:
            move, band = feather(bv, me, eligible, move, blend, cap, lo, hi)
            rep["blend"] = {"blend_mm": K.mm(blend), "band_vertices": int(band.sum()), "band_moved": int((move[band] > 5e-4).sum()),
                            "band_max_move_mm": K.mm(move[band].max()) if band.any() else 0.0,
                            "slope_before_blend": slope_before, "slope_after_blend": edge_slope(me, bv, move, eligible)}
        new = bv - nrm * move[:, None]
        rep.update({"moved": int((move > 0.0005).sum()), "max_move_mm": K.mm(move.max()), "median_move_mm_of_moved": K.mm(np.median(move[move > 0.0005])) if (move > 0.0005).any() else 0.0,
                    "capped_at_max": capped, "max_mm": K.mm(cap), "margin_mm": K.mm(margin)})
        if not rep["dry_run"]:
            K.set_verts(body, new)
        bv2 = new
    else:
        depth = float(L.param("depth_mm", 10)) / 1000
        nf = len(me.polygons)
        cen = np.empty(nf * 3)
        me.polygons.foreach_get("center", cen)
        cen = cen.reshape(-1, 3)
        fn = np.empty(nf * 3)
        me.polygons.foreach_get("normal", fn)
        fn = fn.reshape(-1, 3)
        in_box = np.all((cen >= lo) & (cen <= hi), axis=1)
        remove = []
        for fi in np.flatnonzero(in_box):
            if not all(state[v] == 1 for v in me.polygons[fi].vertices):
                continue
            nv = Vector(fn[fi])
            h = bvh.ray_cast(Vector(cen[fi]) + nv * 1e-4, nv, reach)
            if h[0] is not None and h[3] >= depth:
                remove.append(int(fi))
        rep.update({"faces_in_region": int(in_box.sum()), "faces_removed": len(remove), "depth_mm": K.mm(depth), "tris_before": L.tris(body)})
        if remove and not rep["dry_run"]:
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.faces[i] for i in remove], context="FACES_ONLY")
            bm.to_mesh(me)
            bm.free()
            me.update()
        bv2 = K.verts(body)
        rep["tris_after"] = L.tris(body)

    if not rep["dry_run"]:
        # the safety check: nothing outside the part (and outside the declared blend band) may have moved
        allowed = eligible | (band if mode == "relief" else np.zeros(len(bv), dtype=bool))
        if len(bv2) == len(before):
            mvd = np.linalg.norm(bv2 - before, axis=1) > 1e-7
            rep["moved_outside_eligible"] = int(mvd[~eligible].sum())
            moved_bad = int(mvd[~allowed].sum())
        else:
            rep["moved_outside_eligible"] = 0  # faces were deleted: vertices keep their positions
            moved_bad = 0
        rep["moved_outside_allowed_zone"] = moved_bad
        if moved_bad:
            raise RuntimeError(f"safety check failed: {moved_bad} body vertices outside the part and its blend band moved")
        bpy.context.view_layer.update()
        bvh2 = K.bvh_of(part)
        nrm2 = np.empty(len(me.vertices) * 3)
        me.vertex_normals.foreach_get("vector", nrm2)
        nrm2 = nrm2.reshape(-1, 3)
        pidx = np.empty(sum(len(p.vertices) for p in me.polygons), dtype=int)
        k = 0
        for p in me.polygons:  # vertices left without a face (after a removal) have no normal: leave them out
            pidx[k:k + len(p.vertices)] = p.vertices
            k += len(p.vertices)
        used = np.zeros(len(me.vertices), dtype=bool)
        used[pidx] = True
        cand2 = np.flatnonzero(np.all((K.verts(body) >= lo) & (K.verts(body) <= hi), axis=1) & used)
        st2, _, _, _ = classify(bvh2, K.verts(body)[cand2], nrm2[cand2], reach, poke)
        c2, v2 = int((st2 == 1).sum()), int((st2 == 2).sum())
        rep["show_through_after_pct"] = round(100 * v2 / max(1, c2 + v2), 1)
        rep["eligible_after"] = {"covered": c2, "poking": v2}
        rep["body_checks"] = K.mesh_checks(body)
    L.finish(rep, save=not rep["dry_run"])


L.run(main)