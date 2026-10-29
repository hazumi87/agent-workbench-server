"""mesh_local — change the shape of a LOCAL part of the body mesh: select vertices with a smooth falloff, then translate, push along the surface normal, scale or smooth them, within a bound. The mesh stays skinned: vertex count, face order, UV corners, materials and skin weights are not touched. Saves a checkpoint (not with dry_run).

The rig must be at rest (the verb checks and refuses otherwise: run rig_adopt first), because positions are given in the character's world frame (millimetres, +X = the character's left, +Y backwards, +Z up) and the mesh is stored at rest.

params:
  body        the mesh (default "body")
  region      who is moved, and how much (a weight 1 inside, fading smoothly to 0 across `falloff_mm`; smoothstep). One of:
                {"sphere": {"c": [x, y, z], "r_mm": 40, "falloff_mm": 25}}            (or "radii_mm": [rx, ry, rz] for an ellipsoid)
                {"box": {"c": [x, y, z], "size_mm": [sx, sy, sz], "falloff_mm": 20}}
                {"near_bone": {"bone": "Head", "radius_mm": 60, "falloff_mm": 25}}     within that distance of the bone's segment (Mixamo name without the prefix)
                {"group": {"name": "Head", "min": 0.0}}                                the weight of that bone group itself is the region weight (at least `min`)
                {"all": [region, region, ...]}  the product (the part they share)       {"any": [region, ...]}  the largest
  ops         a list, run in order, each on the region's weight:
                {"op": "translate", "by_mm": [dx, dy, dz]}                             every vertex moves by weight x that vector
                {"op": "normal", "mm": 3}                                              along each vertex's surface normal (+ out, - in)
                {"op": "scale", "factors": [fx, fy, fz] | f, "about_mm": [x, y, z]}    about that point (default the region's centre); factor 1 = unchanged, weighted
                {"op": "smooth", "iterations": 3, "factor": 0.5}                       each vertex towards the mean of its neighbours, weighted (softens an angular edge; it also shrinks a convex part a little)
  mirror      true: every op also runs on the region mirrored in x (centre x negated), with x components negated (a symmetric edit: left and right)
  max_move_mm the largest distance any vertex may end up from where it started (default 20); more refuses the whole edit and says which vertices
  normals     "follow" (default): the mesh's custom (imported) shading normals turn with the surface where it changes, so the shading stays right; "keep": left as they were
  dry_run     true = measure and report, change nothing, save nothing
Refuses: a posed rig, shape keys, a move beyond max_move_mm.
Seam duplicates (vertices at one place, as in a glTF import) always move together: ops work on the distinct places and every vertex takes its place's result, so a UV seam does not open.
Returns: selected (vertices with weight > 0, > 0.99, distinct places), per op: places and vertices moved and the largest move (mm), result: moved vertices, max / mean move (mm), bounds of the moved part before / after, quality (faces flipped, faces under 0.1 mm2 that flipped (counted apart), the smallest face area against before, the largest edge length change in mm, the largest stretch and compression among edges of 1 mm or more that touch a moved vertex), drift: vertex count, UV corners (max change), material per face, skin weights (hash before / after), custom_normals_turned_corners), `moved_by_weight` (how many were moved at each weight band).
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402
from _region import region_weight, flipx  # noqa: E402

def edges_of(me):
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    return e.reshape(-1, 2)


def rot_between(a, b):
    """rotate vectors n (m,3) about the axis a x b by the angle between unit vectors a and b (both (m,3)): returns a function"""
    ax = np.cross(a, b)
    s = np.linalg.norm(ax, axis=1)
    c = (a * b).sum(1)
    k = ax / np.maximum(s[:, None], 1e-12)
    ang = np.arctan2(s, c)
    return k, ang


def main():
    body = bpy.data.objects[L.param("body", "body")]
    if body.type != "MESH":
        raise RuntimeError("body must be a mesh")
    me = body.data
    if me.shape_keys:
        raise RuntimeError("the mesh has shape keys")
    arm = R.find_rig()
    dry = bool(L.param("dry_run", False))
    maxmv = float(L.param("max_move_mm", 20)) / 1000
    ops = L.param("ops") or []
    if not ops or not L.param("region"):
        raise RuntimeError("give a region and ops")
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    P0 = co.reshape(-1, 3)
    M = np.array(body.matrix_world)
    Mi = np.linalg.inv(M)
    V0 = P0 @ M[:3, :3].T + M[:3, 3]
    ev = R.evaluated_verts(body)
    rest_dev = float(np.linalg.norm(ev - V0, axis=1).max() * 1000)
    if rest_dev > 0.01:
        raise RuntimeError(f"the rig is not at rest (the skinned mesh differs from the stored one by {rest_dev:.1f} mm): run rig_adopt first")
    W = np.zeros((n, len(body.vertex_groups)), dtype=np.float32)
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    names = [g.name for g in body.vertex_groups]
    wh0 = hashlib.sha256(np.round(W, 5).tobytes()).hexdigest()[:16]
    uv0 = None
    if me.uv_layers:
        u = np.empty(len(me.loops) * 2)
        me.uv_layers[0].data.foreach_get("uv", u)
        uv0 = u.copy()
    mi0 = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get("material_index", mi0)
    vn0 = np.empty(n * 3)
    me.vertex_normals.foreach_get("vector", vn0)
    vn0 = vn0.reshape(-1, 3)
    # object-space normals to world directions (rotation part only; the body carries the armature's uniform scale)
    Rw = M[:3, :3] / max(np.linalg.norm(M[:3, 0]), 1e-12)

    # a seam-split mesh has several vertices at one place: they must move together, so every op works on the distinct places (groups) and each vertex takes its place's result
    key = np.round(V0 / 1e-5).astype(np.int64)
    _, gid = np.unique(key, axis=0, return_inverse=True)
    gid = gid.ravel()
    ng = int(gid.max()) + 1
    cntg = np.bincount(gid, minlength=ng).astype(float)
    G0 = np.zeros((ng, 3))
    np.add.at(G0, gid, V0)
    G0 /= cntg[:, None]
    Wg = np.zeros((ng, W.shape[1]), dtype=np.float32)
    np.maximum.at(Wg, gid, W)
    NG = np.zeros((ng, 3))
    np.add.at(NG, gid, vn0)
    NG /= np.maximum(np.linalg.norm(NG, axis=1, keepdims=True), 1e-12)
    ee = edges_of(me)
    ge = np.sort(gid[ee], axis=1)
    ge = np.unique(ge[ge[:, 0] != ge[:, 1]], axis=0)
    flips = [False, True] if L.param("mirror") else [False]
    G = G0.copy()
    report, wsel_g = [], np.zeros(ng)
    for o in ops:
        kind = o.get("op")
        mv0 = G.copy()
        for flip in flips:
            w, centre = region_weight(L.param("region"), G0, arm, Wg, names, flip)
            wsel_g = np.maximum(wsel_g, w)
            if kind == "translate":
                G += w[:, None] * flipx(o["by_mm"], flip) / 1000
            elif kind == "normal":
                G += w[:, None] * (float(o["mm"]) / 1000) * (NG @ Rw.T)
            elif kind == "scale":
                f = o["factors"]
                f = np.array([f, f, f], float) if isinstance(f, (int, float)) else np.array(f, float)
                c = flipx(o["about_mm"], flip) / 1000 if "about_mm" in o else centre
                G = c + (G - c) * (1 + w[:, None] * (f - 1))
            elif kind == "smooth":
                for _ in range(int(o.get("iterations", 3))):
                    sm = np.zeros_like(G)
                    cnt = np.zeros(ng)
                    np.add.at(sm, ge[:, 0], G[ge[:, 1]])
                    np.add.at(sm, ge[:, 1], G[ge[:, 0]])
                    np.add.at(cnt, ge[:, 0], 1)
                    np.add.at(cnt, ge[:, 1], 1)
                    avg = sm / np.maximum(cnt, 1)[:, None]
                    G = G + (w * float(o.get("factor", 0.5)))[:, None] * (avg - G)
            else:
                raise RuntimeError(f"unknown op {kind}")
        d = np.linalg.norm(G - mv0, axis=1)
        report.append({"op": kind, "places_moved": int((d > 1e-7).sum()), "vertices_moved": int((d[gid] > 1e-7).sum()), "largest_move_mm": round(float(d.max() * 1000), 3)})
    if wsel_g.max() <= 0:
        lo, hi = V0.min(0) * 1000, V0.max(0) * 1000
        raise RuntimeError(f"the region selects no vertex. Every position and size here is in MILLIMETRES, world frame (+X left, +Y back, +Z up); the body spans x {lo[0]:.0f}..{hi[0]:.0f}, y {lo[1]:.0f}..{hi[1]:.0f}, z {lo[2]:.0f}..{hi[2]:.0f} mm")
    V = V0 + (G - G0)[gid]
    wsel_max = wsel_g[gid]
    move = np.linalg.norm(V - V0, axis=1)
    over = int((move > maxmv + 1e-9).sum())
    if over:
        raise RuntimeError(f"{over} vertices would move more than max_move_mm ({maxmv * 1000:g}): the largest is {move.max() * 1000:.1f} mm, at about {[round(float(x) * 1000, 1) for x in V0[move.argmax()]]} mm. Narrow the region, reduce the op, or raise max_move_mm")
    moved = move > 1e-7
    P1 = (V - M[:3, 3]) @ np.linalg.inv(M[:3, :3]).T
    # quality: flips, area, edge stretch, shading normals
    me.calc_loop_triangles()
    T = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)

    def tri_geo(Pw):
        a, b, c = Pw[T[:, 0]], Pw[T[:, 1]], Pw[T[:, 2]]
        cr = np.cross(b - a, c - a)
        ar = np.linalg.norm(cr, axis=1)
        return cr / np.maximum(ar[:, None], 1e-15), ar / 2

    n0, a0 = tri_geo(V0)
    n1, a1 = tri_geo(V)
    touched = moved[T].any(1)
    big = a0 >= 1e-7  # faces of at least 0.1 mm2 before: tiny ones flip on noise and are counted apart
    flipped_mask = ((n0 * n1).sum(1) < 0) & touched
    flipped, flipped_tiny = int((flipped_mask & big).sum()), int((flipped_mask & ~big).sum())
    ratio = np.where(a0 > 1e-12, a1 / np.maximum(a0, 1e-12), 1.0)
    e = edges_of(me)
    em = moved[e[:, 0]] | moved[e[:, 1]]
    l0 = np.linalg.norm(V0[e[em, 0]] - V0[e[em, 1]], axis=1)
    l1 = np.linalg.norm(V[e[em, 0]] - V[e[em, 1]], axis=1)
    longer = l0 >= 1e-3  # edges of at least 1 mm before: the stretch of a shorter one is noise
    er = l1[longer] / l0[longer] if longer.any() else np.array([1.0])
    dl = float(np.abs(l1 - l0).max() * 1000) if len(l0) else 0.0
    result = {"moved_vertices": int(moved.sum()), "max_move_mm": round(float(move.max() * 1000), 3), "mean_move_mm_of_moved": round(float(move[moved].mean() * 1000), 3) if moved.any() else 0.0,
              "bounds_before_mm": [[round(float(x) * 1000, 1) for x in V0[moved].min(0)], [round(float(x) * 1000, 1) for x in V0[moved].max(0)]] if moved.any() else None,
              "bounds_after_mm": [[round(float(x) * 1000, 1) for x in V[moved].min(0)], [round(float(x) * 1000, 1) for x in V[moved].max(0)]] if moved.any() else None}
    quality = {"faces_flipped": flipped, "tiny_faces_flipped_under_0.1mm2": flipped_tiny, "smallest_face_area_vs_before": round(float(ratio[touched & big].min()), 3) if (touched & big).any() else None,
               "largest_edge_length_change_mm": round(dl, 3),
               "largest_edge_stretch_pct": round(float(max(0.0, er.max() - 1) * 100), 1), "largest_edge_compression_pct": round(float(max(0.0, 1 - er.min()) * 100), 1)}
    bands = {"w_over_0.99": int((wsel_max > 0.99).sum()), "w_0.5_to_0.99": int(((wsel_max > 0.5) & (wsel_max <= 0.99)).sum()), "w_0_to_0.5": int(((wsel_max > 0) & (wsel_max <= 0.5)).sum())}
    corners_turned = None
    if not dry:
        me.vertices.foreach_set("co", np.ascontiguousarray(P1).ravel())
        me.update()
        has_cn = bool(me.has_custom_normals)
        if has_cn and L.param("normals", "follow") == "follow":
            cn = np.empty(len(me.loops) * 3)
            me.corner_normals.foreach_get("vector", cn)
            cn = cn.reshape(-1, 3)  # these are the custom ones, still the old direction
            vn1 = np.empty(n * 3)
            me.vertex_normals.foreach_get("vector", vn1)
            vn1 = vn1.reshape(-1, 3)
            vi = np.empty(len(me.loops), dtype=np.int64)
            me.loops.foreach_get("vertex_index", vi)
            a, b = vn0[vi], vn1[vi]
            ax = np.cross(a, b)
            s = np.linalg.norm(ax, axis=1)
            ang = np.arctan2(s, (a * b).sum(1))
            sel = ang > 1e-5
            k = ax[sel] / np.maximum(s[sel], 1e-12)[:, None]
            v = cn[sel]
            c, sn = np.cos(ang[sel])[:, None], np.sin(ang[sel])[:, None]
            cn[sel] = v * c + np.cross(k, v) * sn + k * (k * v).sum(1)[:, None] * (1 - c)  # Rodrigues: the old shading normal turned as the surface turned
            cn /= np.maximum(np.linalg.norm(cn, axis=1, keepdims=True), 1e-12)
            me.normals_split_custom_set(cn.tolist())
            me.update()
            corners_turned = int(sel.sum())
        # the shading normals now, against the corner normals before, in the area: how many turned a lot
    uv1 = None
    if me.uv_layers:
        u = np.empty(len(me.loops) * 2)
        me.uv_layers[0].data.foreach_get("uv", u)
        uv1 = u
    mi1 = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get("material_index", mi1)
    drift = {"vertices": n, "vertex_count_same": len(me.vertices) == n, "uv_corners_max_change": round(float(np.abs(uv1 - uv0).max()), 7) if uv0 is not None else None,
             "material_per_face_same": bool((mi0 == mi1).all()), "weights_hash_before": wh0, "weights_hash_after": hashlib.sha256(np.round(W, 5).tobytes()).hexdigest()[:16],
             "custom_normals_turned_corners": corners_turned}
    summary = {"dry_run": dry, "selected": {"vertices_weight_over_0": int((wsel_max > 0).sum()), "over_0.99": int((wsel_max > 0.99).sum()), "distinct_places": ng}, "ops": report, "result": result, "quality": quality, "moved_by_weight": bands, "drift": drift}
    L.finish(summary, save=not dry)


L.run(main)
