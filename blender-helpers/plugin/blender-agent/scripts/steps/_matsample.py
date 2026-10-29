"""_matsample - sampling a part's texture maps per vertex through its UVs, and cleaning labels on the mesh. Shared by colour_groups, metal_groups and material_map (not a verb)."""
import numpy as np
import bpy


def image_for(obj, kind="base", want=None):
    """the image of the part's material that feeds `base` (Base Color), `metallic` / `roughness` (the packed ORM / metallic-roughness map) or any image named `want`"""
    if want:
        im = bpy.data.images.get(want)
        if im is None:
            raise RuntimeError(f"no image named {want}")
        return im
    sock = {"base": "Base Color", "metallic": "Metallic", "roughness": "Roughness"}[kind]
    for m in obj.data.materials:
        if m is None or not m.use_nodes:
            continue
        b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if b is None or not b.inputs[sock].links:
            continue
        n = b.inputs[sock].links[0].from_node
        for _ in range(6):
            if n is None or n.type == "TEX_IMAGE":
                break
            ins = [i for i in n.inputs if i.links]
            n = ins[0].links[0].from_node if ins else None
        if n is not None and n.type == "TEX_IMAGE" and n.image:
            return n.image
    if kind == "base":
        for m in obj.data.materials:
            if m is not None and m.use_nodes:
                for n in m.node_tree.nodes:
                    if n.type == "TEX_IMAGE" and n.image:
                        return n.image
    raise RuntimeError(f"the part's materials have no image feeding {sock}: give `image` (the name of the picture)")


def pixels(im):
    w, h = im.size
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    return px.reshape(h, w, 4)  # rows from the bottom (v = 0), values as stored


def bilinear(img, u, v):
    h, w = img.shape[:2]
    x = np.clip((u % 1.0) * w - 0.5, 0, w - 1.001)
    y = np.clip((v % 1.0) * h - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    return img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy


def vertex_values(obj, img, uvname):
    """per vertex: the mean of the image values at the vertex's UV in every face that uses it (a vertex on a UV seam has several), shape (n_vertices, channels)"""
    me = obj.data
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers[uvname].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    vi = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", vi)
    vals = bilinear(img, uv[:, 0], uv[:, 1])
    ch = vals.shape[1]
    nv = len(me.vertices)
    cnt = np.bincount(vi, minlength=nv).astype(float)
    out = np.zeros((nv, ch))
    for c in range(ch):
        out[:, c] = np.bincount(vi, weights=vals[:, c], minlength=nv)
    out /= np.maximum(cnt, 1)[:, None]  # the mean over the faces that share the vertex (a vertex on a UV seam samples both sides)
    return out


def adjacency(obj):
    """vertex neighbours by POSITION (so seam-split vertices count as one place): (index array per vertex)"""
    me = obj.data
    P = np.array([list(v.co) for v in me.vertices])
    key = {}
    pid = np.array([key.setdefault(tuple(np.round(p, 5)), len(key)) for p in P])
    nbr = [set() for _ in range(len(key))]
    for e in me.edges:
        a, b = pid[e.vertices[0]], pid[e.vertices[1]]
        if a != b:
            nbr[a].add(b)
            nbr[b].add(a)
    return pid, [np.array(sorted(s), dtype=np.int64) for s in nbr], len(key)


def mode_filter(labels, pid, nbr, npos, rings):
    """majority label over the vertex's neighbours (the vertex counts too), `rings` times: removes single-vertex speckle without moving a clean border"""
    lab = labels.copy()
    L_ = np.full(npos, -1, dtype=np.int64)
    for _ in range(int(rings)):
        L_[pid] = lab  # one label per place
        new = L_.copy()
        for p in range(npos):
            n = nbr[p]
            if len(n) == 0:
                continue
            votes = np.concatenate([[L_[p]], L_[n]])
            votes = votes[votes >= 0]
            if len(votes):
                vals, cnt = np.unique(votes, return_counts=True)
                best = vals[np.argmax(cnt)]
                if cnt.max() > (len(votes) / 2.0):
                    new[p] = best
        L_ = new
        lab = L_[pid]
    return lab


def set_group(obj, name, idx, weight=1.0):
    g = obj.vertex_groups.get(name)
    if g is not None:
        obj.vertex_groups.remove(g)
    g = obj.vertex_groups.new(name=name)
    if len(idx):
        g.add([int(i) for i in idx], weight, "REPLACE")
    return g


def kmeans(X, k=6, iters=25, seed=3):
    rng = np.random.default_rng(seed)
    X = np.asarray(X, float)
    if len(X) > 20000:
        X = X[rng.choice(len(X), 20000, replace=False)]
    C = X[rng.choice(len(X), min(k, len(X)), replace=False)]
    for _ in range(iters):
        lab = np.argmin(((X[:, None, :] - C[None]) ** 2).sum(-1), axis=1)
        for j in range(len(C)):
            if (lab == j).any():
                C[j] = X[lab == j].mean(0)
    lab = np.argmin(((X[:, None, :] - C[None]) ** 2).sum(-1), axis=1)
    cnt = np.bincount(lab, minlength=len(C))
    order = np.argsort(-cnt)
    return C[order], cnt[order]


def classify(vals255, ranges, default_tol=40.0):
    """label per vertex: the index of the nearest range whose distance <= its tol, else -1"""
    lab = np.full(len(vals255), -1, dtype=np.int64)
    best = np.full(len(vals255), np.inf)
    for i, r in enumerate(ranges):
        d = np.linalg.norm(vals255 - np.array(r["rgb"], float), axis=1)
        ok = (d <= float(r.get("tol", default_tol))) & (d < best)
        lab[ok] = i
        best[ok] = d[ok]
    return lab, best


PALETTE = [(230, 25, 75), (60, 180, 75), (0, 130, 200), (245, 130, 48), (145, 30, 180), (70, 240, 240), (240, 50, 230), (210, 245, 60), (250, 190, 190), (0, 128, 128), (170, 110, 40), (128, 128, 0)]


def legend_strip(names, colours, width, row_px=30):
    """a picture (height x width x 3, row 0 at the top) with one row per group: a colour swatch and the name, drawn with Blender's text in a scratch scene"""
    import os
    import tempfile
    from mathutils import Vector
    import math
    scn = bpy.data.scenes.new("legend-scn")
    n = len(names)
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "FLAT"
    scn.display.shading.color_type = "MATERIAL"
    scn.render.resolution_x, scn.render.resolution_y = int(width), int(row_px * n)
    scn.render.resolution_percentage = 100
    scn.render.image_settings.file_format = "PNG"
    scn.view_settings.view_transform = "Standard"
    scn.render.film_transparent = False
    w = bpy.data.worlds.new("legend-w")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.08, 0.08, 0.1, 1)
    scn.world = w
    cam_d = bpy.data.cameras.new("legend-cam")
    cam_d.type = "ORTHO"
    cam_d.ortho_scale = width / row_px  # units: one row = 1.0 high
    cam = bpy.data.objects.new("legend-cam", cam_d)
    scn.collection.objects.link(cam)
    cam.location = (width / row_px / 2, -n / 2.0, 5)
    scn.camera = cam

    def mat(c):
        m = bpy.data.materials.new("lg")
        m.diffuse_color = (c[0], c[1], c[2], 1)
        return m
    for i, (nm, c) in enumerate(zip(names, colours)):
        y = -i - 0.5
        bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0.7, y, 0))
        sw = bpy.context.active_object
        sw.scale = (0.9, 0.7, 1)
        for c_ in list(sw.users_collection):
            c_.objects.unlink(sw)
        scn.collection.objects.link(sw)
        sw.data.materials.append(mat((c[0] / 255.0, c[1] / 255.0, c[2] / 255.0)))
        cu = bpy.data.curves.new("lg-t", "FONT")
        cu.body = str(nm)
        cu.size = 0.62
        cu.align_y = "CENTER"
        t = bpy.data.objects.new("lg-t", cu)
        t.location = (1.6, y, 0.01)
        scn.collection.objects.link(t)
        t.data.materials.append(mat((0.95, 0.95, 0.95)))
    p = os.path.join(tempfile.gettempdir(), "legend-strip.png")
    scn.render.filepath = p
    bpy.ops.render.render(scene=scn.name, write_still=True)
    import uv_common as UC
    arr = UC.load_image(p)[..., :3]
    bpy.data.scenes.remove(scn)
    return arr


def flat_pictures(obj, labels, colours, prefix, res=600, dirs=None, size=None, names=None, palette=True):
    """clay pictures of the part with each label as a flat colour (-1 = grey), plus a legend strip with the group names under each picture. With `palette` (default) the colours are a fixed set of distinct ones, not the ranges' own (close browns are hard to tell apart); the legend names the group beside its colour. The part's materials are put back afterwards."""
    import os
    from mathutils import Vector
    import _lib as L
    import uv_common as UC
    from _handview import render_views
    cols = [PALETTE[i % len(PALETTE)] for i in range(len(colours))] if palette else [tuple(c) for c in colours]
    me = obj.data
    old_idx = [p.material_index for p in me.polygons]
    old_mats = list(me.materials)
    me.materials.clear()
    grey = bpy.data.materials.new("mm-grey")
    grey.diffuse_color = (0.5, 0.5, 0.5, 1)
    me.materials.append(grey)
    for i, c in enumerate(cols):
        m = bpy.data.materials.new(f"mm-{i}")
        m.diffuse_color = (c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, 1)
        me.materials.append(m)
    for p in me.polygons:
        ls = labels[list(p.vertices)]
        vals, cnt = np.unique(ls, return_counts=True)
        p.material_index = int(vals[np.argmax(cnt)]) + 1
    P = np.array([list(v.co) for v in me.vertices])
    mw = np.array(obj.matrix_world)
    P = P @ mw[:3, :3].T + mw[:3, 3]
    ctr = Vector(((P.min(0) + P.max(0)) / 2).tolist())
    ext = float(np.ptp(P, axis=0).max())
    dd = dirs or {"front": Vector((0, -1, 0.15)), "back": Vector((0, 1, 0.15)), "side": Vector((-1, 0, 0.15)), "top": Vector((0.001, 0.001, 1))}
    files = render_views([obj], ctr, size or ext * 1.3, prefix, res, dd)
    me.materials.clear()
    for m in old_mats:
        me.materials.append(m)
    for p, mi in zip(me.polygons, old_idx):
        p.material_index = mi
    if names:
        counts = [int((labels == i).sum()) for i in range(len(colours))]
        rows = [f"{n}  ({counts[i]:,} vertices)" for i, n in enumerate(names)] + ["no group (grey)"]
        strip = legend_strip(rows, cols + [(128, 128, 128)], res)
        for f in files:
            img = UC.load_image(f)[..., :3]
            UC.save_image(np.concatenate([img, strip], axis=0).astype(np.float32), f, "sRGB")
    return files
