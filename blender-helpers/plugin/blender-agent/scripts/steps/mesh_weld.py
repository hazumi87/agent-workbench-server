"""mesh_weld — join the duplicate vertices of a seam-split mesh (a glTF import splits every UV or normal seam into two vertices at the same place) on a mesh that is ALREADY skinned, without changing its look. Saves a checkpoint (not with dry_run).

Only vertices at (nearly) the same place are joined, and only when their skin weights agree. Nothing is decimated or moved by more than `tol_mm`; faces, materials and UV corners are untouched (a UV is kept per face corner, so a UV seam stays a seam: the UV
island borders do not change). The report measures the result against the mesh as it was.

params:
  body             the mesh (default "body")
  tol_mm           two vertices count as the same place when they are this close (default 0.01 mm: float rounding)
  max_weight_diff  the largest difference in any bone's weight for two vertices to be joined (default 0.001); a pair that differs more is left split and counted in `kept_split_weight`
  dry_run          true = measure and report what would be joined, change nothing, save nothing
Refuses when the mesh has shape keys (a vertex cannot be joined across keys).
Returns: before / after: vertices, faces, triangles, connected components, non-manifold edges, loose vertices, boundary edges; joined (vertices removed, clusters), kept_split (clusters not joined: because of weights, or because two of them share a face);
drift: face corners positions (max mm), UV corners (max abs change and loop count same), material per face (same or not), faces same count, weights (max change at any surviving vertex vs the corners' original weights), the weight hash
of the bound groups; corner_normals_max_deg and corner_normals_over_1deg (the change of each face corner's shading normal; when the mesh has custom normals they are put back per corner after the weld); has_custom_normals before / after; evaluated body vs before per face corner (max mm, in whatever pose the rig is in: run rig_adopt first to have it at rest).
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import kdtree  # noqa: E402
import _lib as L  # noqa: E402


def counts(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    seen, comps = set(), 0
    for v0 in bm.verts:
        if v0.index in seen:
            continue
        comps += 1
        seen.add(v0.index)
        st = [v0]
        while st:
            v = st.pop()
            for e in v.link_edges:
                w = e.other_vert(v)
                if w.index not in seen:
                    seen.add(w.index)
                    st.append(w)
    out = {"vertices": len(bm.verts), "faces": len(bm.faces), "triangles": sum(len(f.verts) - 2 for f in bm.faces), "components": comps,
           "non_manifold_edges": sum(1 for e in bm.edges if not e.is_manifold), "boundary_edges": sum(1 for e in bm.edges if e.is_boundary), "loose_vertices": sum(1 for v in bm.verts if not v.link_edges)}
    bm.free()
    return out


def loop_data(me):
    """per face corner: position, uv (first layer, else None), the face's material index"""
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    V = co.reshape(-1, 3)
    vi = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", vi)
    uv = None
    if me.uv_layers:
        u = np.empty(len(me.loops) * 2)
        me.uv_layers[0].data.foreach_get("uv", u)
        uv = u.reshape(-1, 2)
    mi = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get("material_index", mi)
    return V[vi], uv, mi, vi


def corner_normals(me):
    n = np.empty(len(me.loops) * 3)
    me.corner_normals.foreach_get("vector", n)
    return n.reshape(-1, 3)


def cn_drift(cn1, cn0, same):
    if not same:
        return {"corner_normals_max_deg": None}
    a = np.degrees(np.arccos(np.clip((cn1 * cn0).sum(1), -1, 1)))
    return {"corner_normals_max_deg": round(float(a.max()), 4), "corner_normals_over_1deg": int((a > 1).sum()), "corners": len(a)}


def weights(body):
    me = body.data
    W = np.zeros((len(me.vertices), len(body.vertex_groups)), dtype=np.float32)
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return W


def main():
    body = bpy.data.objects[L.param("body", "body")]
    if body.type != "MESH":
        raise RuntimeError("body must be a mesh")
    me = body.data
    if me.shape_keys:
        raise RuntimeError("the mesh has shape keys: a vertex cannot be joined across keys")
    tol = float(L.param("tol_mm", 0.01)) / 1000
    wtol = float(L.param("max_weight_diff", 0.001))
    dry = bool(L.param("dry_run", False))
    # the evaluated body at rest, to compare at the end
    import rig_common as R
    ev0 = R.evaluated_verts(body)

    before = counts(me)
    P0, UV0, MI0, VI0 = loop_data(me)
    W0 = weights(body)
    has_cn0 = bool(me.has_custom_normals)
    CN0 = corner_normals(me)
    wh0 = hashlib.sha256(np.round(W0, 5).tobytes()).hexdigest()[:16]

    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    V = co.reshape(-1, 3)
    kd = kdtree.KDTree(n)
    for i in range(n):
        kd.insert(V[i], i)
    kd.balance()
    # clusters of vertices within tol of each other (union by nearest-neighbour search)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for i in range(n):
        for _, j, _d in kd.find_range(V[i], tol):
            if j != i:
                parent[find(j)] = find(i)
    clusters = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    clusters = [c for c in clusters.values() if len(c) > 1]

    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    targetmap, kept_w, kept_face = {}, 0, 0
    for c in clusters:
        faces_of = [set(f.index for f in bm.verts[i].link_faces) for i in c]
        edges_of = [set(e.index for e in bm.verts[i].link_edges) for i in c]
        shares = any(faces_of[a] & faces_of[b] or edges_of[a] & edges_of[b] for a in range(len(c)) for b in range(a + 1, len(c)))
        if shares:
            kept_face += 1
            continue
        if len(W0) and np.abs(W0[c] - W0[c[0]]).max() > wtol:
            kept_w += 1
            continue
        for i in c[1:]:
            targetmap[bm.verts[i]] = bm.verts[c[0]]
    joined = len(targetmap)
    after = before
    if not dry and targetmap:
        bmesh.ops.weld_verts(bm, targetmap=targetmap)
        bm.to_mesh(me)
        me.update()
        if has_cn0 and len(me.loops) == len(CN0):
            me.normals_split_custom_set(CN0.tolist())  # put every face corner's own shading normal back
            me.update()
    bm.free()
    if not dry:
        after = counts(me)
        P1, UV1, MI1, VI1 = loop_data(me)
        W1 = weights(body)
        ev1 = R.evaluated_verts(body)
        drift = {"face_corner_positions_max_mm": round(float(np.linalg.norm(P1 - P0, axis=1).max() * 1000), 5) if len(P1) == len(P0) else None,
                 "uv_corners_max_abs": round(float(np.abs(UV1 - UV0).max()), 7) if UV0 is not None and UV1 is not None and UV1.shape == UV0.shape else None,
                 "loops_same_count": len(P1) == len(P0), "faces_same_count": len(MI1) == len(MI0), "material_per_face_same": bool(len(MI1) == len(MI0) and (MI1 == MI0).all()),
                 "weights_max_change_at_corners": round(float(np.abs(W1[VI1] - W0[VI0]).max()), 6) if len(VI1) == len(VI0) and W0.size else None,
                 "weights_hash_before": wh0, "evaluated_body_vs_before_max_mm": round(float(np.linalg.norm(ev1[VI1] - ev0[VI0], axis=1).max() * 1000), 5) if len(VI1) == len(VI0) else None,
                 **cn_drift(corner_normals(me), CN0, len(VI1) == len(VI0))}
    else:
        drift = None
    summary = {"dry_run": dry, "tol_mm": tol * 1000, "max_weight_diff": wtol, "before": before, "after": after if not dry else None,
               "would_join" if dry else "joined": {"vertices_removed": joined, "clusters": len(clusters) - kept_w - kept_face},
               "kept_split": {"clusters_total": len(clusters), "kept_split_weight": kept_w, "kept_split_shared_face": kept_face},
               "drift": drift, "has_custom_normals": {"before": has_cn0, "after": bool(me.has_custom_normals)}}
    L.finish(summary, save=not dry)


L.run(main)
