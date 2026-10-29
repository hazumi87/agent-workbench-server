"""head_graft — put a better head's GEOMETRY and its own texture on a body mesh (experimental).

The job's mesh is the body. `head_src` is a GLB of the same character's head (or bust).
 1. align the head to the body's head: similarity ICP, multi-start over a list of scales
 2. stage "align" stops there (both meshes in the scene, to check the fit)
 3. stage "graft": cut the head GLB below its chin (head_cut), delete the body's head faces
    (body_cut and above, within x_limit of the centre line), decimate each part to its own
    budget, join them into one mesh. The head keeps its own material and texture; nothing is
    baked and there is no blend band, so the join shows raw.

params (heights are fractions of the BODY's height, after alignment):
  head_src        GLB path (absolute, or relative to the tool root)                     [required]
  stage           "align" or "graft" (default "graft")
  head_from       fraction of the head GLB's height where its head starts, for the fit (default 0.56)
  body_head_from  fraction of the body's height where its head starts, for the fit (default 0.70)
  x_limit         metres from the centre line that count as head/neck, not arms (default 0.17)
  scales          start scales for the fit (default 0.45 .. 1.0)
  head_cut        height below which the head GLB is cut away (default 0.66)
  body_cut        height from which the body's own head faces are removed (default 0.72)
  head_tris       head budget (default 50000)
  body_tris       body budget (default 25000)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector, kdtree  # noqa: E402
import _lib as L  # noqa: E402


def world_verts(o):
    co = np.empty(len(o.data.vertices) * 3, dtype=np.float64)
    o.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(o.matrix_world)
    return co @ m[:3, :3].T + m[:3, 3]


def umeyama(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    u, d, vt = np.linalg.svd(dc.T @ sc / len(src))
    s_ = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        s_[2, 2] = -1
    r = u @ s_ @ vt
    var = (sc ** 2).sum() / len(src)
    s = np.trace(np.diag(d) @ s_) / var
    return s, r, mu_d - s * r @ mu_s


def icp_from(sub, tree, dst, s0, iters=40, keep=0.7):
    p = sub * s0
    off = np.array([(dst[:, 0].max() + dst[:, 0].min()) / 2 - (p[:, 0].max() + p[:, 0].min()) / 2,
                    (dst[:, 1].max() + dst[:, 1].min()) / 2 - (p[:, 1].max() + p[:, 1].min()) / 2,
                    dst[:, 2].max() - p[:, 2].max()])
    p = p + off
    total = np.eye(4)
    total[:3, :3] *= s0
    total[:3, 3] = off
    res = None
    for _ in range(iters):
        idx = np.empty(len(p), dtype=int)
        dist = np.empty(len(p))
        for i, q in enumerate(p):
            _, j, dd = tree.find(q)
            idx[i], dist[i] = j, dd
        sel = dist <= np.quantile(dist, keep)
        res = float(np.median(dist[sel]))
        s, r, t = umeyama(p[sel], dst[idx[sel]])
        p = s * (p @ r.T) + t
        step = np.eye(4)
        step[:3, :3] = s * r
        step[:3, 3] = t
        total = step @ total
    return total, res


def align(src, dst, scales):
    tree = kdtree.KDTree(len(dst))
    for i, p in enumerate(dst):
        tree.insert(p, i)
    tree.balance()
    rng = np.random.default_rng(0)
    sub = src[rng.choice(len(src), min(len(src), 2500), replace=False)]
    tried = []
    best = None
    for s0 in scales:
        total, res = icp_from(sub, tree, dst, s0)
        det = abs(np.linalg.det(total[:3, :3])) ** (1 / 3)
        tried.append([round(s0, 2), round(float(det), 3), round(res * 1000, 1)])
        if best is None or res < best[1]:
            best = (total, res)
    return best[0], best[1], tried


def weld(obj, dist=1e-4):
    """GLB meshes carry duplicated vertices at UV/normal seams; decimating without welding them cracks the surface."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=dist)
    bm.to_mesh(obj.data)
    bm.free()


def decimate(obj, target):
    weld(obj)
    before = L.tris(obj)
    if before <= target:
        return before, before
    L.activate(obj)
    mod = obj.modifiers.new("Decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = target / before
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return before, L.tris(obj)


def main():
    head_src = L.resolve(L.param("head_src"))
    if not os.path.isfile(head_src):
        raise FileNotFoundError(head_src)
    stage = L.param("stage", "graft")
    body = L.the_mesh()
    L.activate(body)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    weld(body)
    bz = world_verts(body)
    z0, H = bz[:, 2].min(), bz[:, 2].max() - bz[:, 2].min()
    x_lim = float(L.param("x_limit", 0.17))

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=head_src)
    heads = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if len(heads) != 1:
        raise RuntimeError(f"head GLB has {len(heads)} meshes, expected 1")
    head = heads[0]
    L.activate(head)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    weld(head)
    hv = world_verts(head)
    hh = hv[:, 2].max() - hv[:, 2].min()
    src_pts = hv[hv[:, 2] >= hv[:, 2].min() + float(L.param("head_from", 0.56)) * hh]
    dst_mask = (bz[:, 2] >= z0 + float(L.param("body_head_from", 0.70)) * H) & (np.abs(bz[:, 0]) <= x_lim)
    scales = L.param("scales", [0.45, 0.55, 0.65, 0.75, 0.85, 1.0])
    total, resid, tried = align(src_pts, bz[dst_mask], scales)
    head.matrix_world = Matrix(total.tolist()) @ head.matrix_world
    bpy.context.view_layer.update()
    hw = world_verts(head)
    scale = float(abs(np.linalg.det(total[:3, :3])) ** (1 / 3))
    rot = (total[:3, :3] / scale)
    yaw = float(np.degrees(np.arctan2(rot[1, 0], rot[0, 0])))
    info = {"fit_scale": round(scale, 4), "fit_residual_mm": round(resid * 1000, 1), "fit_yaw_deg": round(yaw, 1),
            "tried_scale_det_resid_mm": tried,
            "head_z_frac": [round((hw[:, 2].min() - z0) / H, 3), round((hw[:, 2].max() - z0) / H, 3)]}
    if stage == "align":
        L.finish(info, save=True)
        return

    # ---- cut the head GLB below its chin ------------------------------------------------------
    head_cut = z0 + float(L.param("head_cut", 0.635)) * H
    bm = bmesh.new()
    bm.from_mesh(head.data)
    inv = head.matrix_world.inverted()
    plane_co = inv @ Vector((0, 0, head_cut))
    plane_no = (inv.to_3x3().transposed() @ Vector((0, 0, 1))).normalized()
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    mw = head.matrix_world
    # bmesh.ops.bisect_plane can leave the surface uncut, so cut by face centre instead:
    # a slightly ragged edge, which is hidden under the jaw and capped below
    gone_h = [f for f in bm.faces if (mw @ f.calc_center_median()).z < head_cut]
    open_before = {e.index for e in bm.edges if e.is_boundary}
    bmesh.ops.delete(bm, geom=gone_h, context="FACES")
    plane_dbg = {"head_faces_cut": len(gone_h)}
    bm.edges.index_update()
    cap = [e for e in bm.edges if e.is_boundary and abs((mw @ ((e.verts[0].co + e.verts[1].co) / 2)).z - head_cut) < 0.012]
    cap_faces = bmesh.ops.holes_fill(bm, edges=cap, sides=0)["faces"] if cap else []
    if cap_faces:
        bmesh.ops.triangulate(bm, faces=cap_faces)
    head_cap_edges = len(cap)
    on_plane = [e for e in bm.edges if abs((mw @ ((e.verts[0].co + e.verts[1].co) / 2)).z - head_cut) < 2e-3]
    bnd = [e for e in bm.edges if e.is_boundary]
    bz_ = [(mw @ ((e.verts[0].co + e.verts[1].co) / 2)).z for e in bnd]
    cap_debug = {"edges_on_plane": len(on_plane), "of_which_boundary": sum(e.is_boundary for e in on_plane),
                 "link_faces": sorted({len(e.link_faces) for e in on_plane}), "boundary_edges": len(bnd),
                 "boundary_z_frac": [round((min(bz_) - z0) / H, 3), round((max(bz_) - z0) / H, 3)] if bz_ else None,
                 "head_cut_frac": round((head_cut - z0) / H, 3), **plane_dbg}
    bm.to_mesh(head.data)
    bm.free()

    # ---- delete the body's own head faces ------------------------------------------------------
    body_cut = z0 + float(L.param("body_cut", 0.645)) * H
    me = body.data
    n = len(me.polygons)
    cen = np.empty(n * 3)
    me.polygons.foreach_get("center", cen)
    cen = cen.reshape(-1, 3)
    gone = (cen[:, 2] >= body_cut) & (np.abs(cen[:, 0]) <= x_lim)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if gone[f.index]], context="FACES")
    # close the hole the removed head leaves (a lid in the body's material; it sits under the new head)
    lid = [e for e in bm.edges if e.is_boundary
           and (e.verts[0].co.z + e.verts[1].co.z) / 2 >= body_cut - 0.02
           and abs((e.verts[0].co.x + e.verts[1].co.x) / 2) <= x_lim + 0.02]
    lid_faces = bmesh.ops.holes_fill(bm, edges=lid, sides=0)["faces"] if lid else []
    if lid_faces:
        bmesh.ops.triangulate(bm, faces=lid_faces)
    body_lid_edges = len(lid)
    bm.to_mesh(me)
    bm.free()

    hb, ha = decimate(head, int(L.param("head_tris", 50000)))
    bb, ba = decimate(body, int(L.param("body_tris", 25000)))

    # ---- join into one mesh (materials stay separate; no vertex merge) -------------------------
    bpy.ops.object.select_all(action="DESELECT")
    head.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    out = L.the_mesh()
    info.update({"head_tris": [hb, ha], "body_tris": [bb, ba], "tris": L.tris(out),
                 "materials": [m.name for m in out.data.materials if m], "uv_layers": [u.name for u in out.data.uv_layers],
                 "body_faces_removed": int(gone.sum()), "head_cap_edges": head_cap_edges, "body_lid_edges": body_lid_edges, "cap_debug": cap_debug})
    L.finish(info, save=True)


L.run(main)