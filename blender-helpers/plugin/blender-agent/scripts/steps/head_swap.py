"""head_swap — put a better head's COLOUR on a body mesh's own head (option b: the body's shape is kept).

The job's mesh is the body. `head_src` is a second GLB (a head or bust of the same character).
 1. align the head to the body's head (similarity ICP on the head parts of both)
 2. decimate the body to a budget, keeping more triangles in the head region (vertex-group weights)
 3. give the head region its own material + its own UV unwrap (the body's UVs/texture are untouched)
 4. bake the head GLB's base colour onto that region (CPU Cycles, selected -> active), pack the image

params:
  head_src        GLB path (absolute, or relative to the tool root)            [required]
  head_from       fraction of the head GLB's height where ITS head starts (default 0.58; below it is neck/shoulders)
  body_head_from  fraction of the body's height where ITS head starts (default 0.80), used for the ICP target
  z_cut           fraction of the body's height: faces above it (and inside x_limit) are the head region (default 0.70)
  x_limit         metres: faces further than this from x=0 are not head (keeps the arms out) (default 0.17)
  target_tris     whole-mesh budget (default 70000)
  body_weight     decimate weight of the non-head vertices, head = 1 (default 0.3)
  res             baked head texture size (default 2048)
  ray             max ray distance for the bake, metres (default 0.05)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, kdtree  # noqa: E402
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


def icp(src, dst, iters=60, keep=0.7):
    """similarity ICP with trimmed matches; returns a 4x4 mapping src -> dst frame, and the median residual."""
    tree = kdtree.KDTree(len(dst))
    for i, p in enumerate(dst):
        tree.insert(p, i)
    tree.balance()
    rng = np.random.default_rng(0)
    sub = src[rng.choice(len(src), min(len(src), 5000), replace=False)]
    # init: match the z extent, centre x/y, align the tops
    s0 = (dst[:, 2].max() - dst[:, 2].min()) / (sub[:, 2].max() - sub[:, 2].min())
    p = sub * s0
    off = np.array([(dst[:, 0].max() + dst[:, 0].min()) / 2 - (p[:, 0].max() + p[:, 0].min()) / 2,
                    (dst[:, 1].max() + dst[:, 1].min()) / 2 - (p[:, 1].max() + p[:, 1].min()) / 2,
                    dst[:, 2].max() - p[:, 2].max()])
    p = p + off
    total = np.eye(4)
    total[:3, :3] *= s0
    total[:3, 3] = off
    med = None
    for _ in range(iters):
        idx = np.empty(len(p), dtype=int)
        dist = np.empty(len(p))
        for i, q in enumerate(p):
            _, j, dd = tree.find(q)
            idx[i], dist[i] = j, dd
        med = float(np.median(dist))
        sel = dist <= np.quantile(dist, keep)
        s, r, t = umeyama(p[sel], dst[idx[sel]])
        p = s * (p @ r.T) + t
        step = np.eye(4)
        step[:3, :3] = s * r
        step[:3, 3] = t
        total = step @ total
    return total, med


def main():
    head_src = L.resolve(L.param("head_src"))
    if not os.path.isfile(head_src):
        raise FileNotFoundError(head_src)
    body = L.the_mesh()
    L.activate(body)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bz = world_verts(body)
    H = bz[:, 2].max() - bz[:, 2].min()
    z0 = bz[:, 2].min()

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=head_src)
    heads = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if len(heads) != 1:
        raise RuntimeError(f"head GLB has {len(heads)} meshes, expected 1")
    head = heads[0]
    L.activate(head)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    hv = world_verts(head)
    hh = hv[:, 2].max() - hv[:, 2].min()
    src_pts = hv[hv[:, 2] >= hv[:, 2].min() + float(L.param("head_from", 0.58)) * hh]
    dst_pts = bz[bz[:, 2] >= z0 + float(L.param("body_head_from", 0.80)) * H]
    total, resid = icp(src_pts, dst_pts)
    head.matrix_world = Matrix(total.tolist()) @ head.matrix_world
    bpy.context.view_layer.update()
    scale = float(np.cbrt(abs(np.linalg.det(total[:3, :3]))))

    # ---- head region + weighted decimate -----------------------------------------------------
    z_cut = z0 + float(L.param("z_cut", 0.70)) * H
    x_lim = float(L.param("x_limit", 0.17))
    vz = world_verts(body)
    is_head_v = (vz[:, 2] >= z_cut) & (np.abs(vz[:, 0]) <= x_lim)
    vg = body.vertex_groups.new(name="head_w")
    w_body = float(L.param("body_weight", 1.0))
    # a HIGHER weight is decimated MORE, so the head gets the lower weight
    w_head = float(L.param("head_weight", 0.5))
    for i in np.flatnonzero(is_head_v):
        vg.add([int(i)], w_head, "REPLACE")
    for i in np.flatnonzero(~is_head_v):
        vg.add([int(i)], w_body, "REPLACE")
    tris_before = L.tris(body)
    target = int(L.param("target_tris", 70000))
    L.activate(body)
    mod = body.modifiers.new("Decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = target / tris_before
    mod.vertex_group = "head_w"
    mod.vertex_group_factor = 1.0
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    if "head_w" in body.vertex_groups:  # the modifier apply can invalidate the old reference
        body.vertex_groups.remove(body.vertex_groups["head_w"])

    me = body.data
    n = len(me.polygons)
    cen = np.empty(n * 3)
    me.polygons.foreach_get("center", cen)
    cen = cen.reshape(-1, 3)
    is_head_f = (cen[:, 2] >= z_cut) & (np.abs(cen[:, 0]) <= x_lim)
    head_tris = int(sum(len(p.vertices) - 2 for p, h in zip(me.polygons, is_head_f) if h))
    total_tris = L.tris(body)

    # ---- own material + own UVs for the head region --------------------------------------------
    res = int(L.param("res", 2048))
    img = bpy.data.images.new("HeadColor", res, res, alpha=False)
    mat = bpy.data.materials.new("Head")
    mat.use_nodes = True
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    bsdf = next(nd for nd in nt.nodes if nd.type == "BSDF_PRINCIPLED")
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.nodes.active = tex

    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        f.select = bool(is_head_f[f.index])
    bm.to_mesh(me)
    bm.free()
    L.activate(body, "EDIT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")

    # bake object: just the head faces, one material
    bk = body.copy()
    bk.data = body.data.copy()
    bpy.context.scene.collection.objects.link(bk)
    bm = bmesh.new()
    bm.from_mesh(bk.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not is_head_f[f.index]], context="FACES")
    bm.to_mesh(bk.data)
    bm.free()
    bk.data.materials.clear()
    bk.data.materials.append(mat)

    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 1
    bpy.ops.object.select_all(action="DESELECT")
    head.select_set(True)
    bk.select_set(True)
    bpy.context.view_layer.objects.active = bk
    ray = float(L.param("ray", 0.05))
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                        max_ray_distance=ray, cage_extrusion=ray / 4, margin=16, margin_type="EXTEND",
                        target="IMAGE_TEXTURES", use_clear=True)
    img.pack()
    px = np.empty(res * res * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    painted = float(np.mean(np.abs(px[:, :3] - px[0, :3]).sum(1) > 1e-4))

    # head faces of the real body use the baked material
    me.materials.append(mat)
    slot = len(me.materials) - 1
    for p, h in zip(me.polygons, is_head_f):
        if h:
            p.material_index = slot
    bpy.data.objects.remove(bk, do_unlink=True)
    bpy.data.objects.remove(head, do_unlink=True)

    L.finish({"head_scale": round(scale, 4), "icp_median_residual_m": round(resid, 5),
              "tris_before": tris_before, "tris": total_tris, "head_tris": head_tris,
              "body_tris": total_tris - head_tris, "head_faces_pct": round(100 * float(is_head_f.mean()), 1),
              "bake_res": res, "baked_pixels_pct": round(100 * painted, 1)}, save=True)


L.run(main)