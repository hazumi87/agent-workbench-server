"""card_proxy — replace dense PLANAR cut-out cards (foliage drawn as thousands of triangles on one flat plane, with the picture mapped on it) by ONE quad each, and put the cut-out's silhouette into the texture's alpha, so the shape stays and the triangles go. Saves a checkpoint (not with dry_run). Run it on a copy (verb 87).

How: each object's UV -> local position map is fitted as an exact affine map (least squares); an object is a card only when the largest residual is under `max_residual_m`, else it is reported and left alone. The quad spans the UV bounding box of the object's triangles (so its position, height and width are those of the original). The silhouette is the union of the object's triangles drawn in UV space at the image's resolution; each material gets a NEW image = the old picture with alpha = old alpha x silhouette (objects that share a material share one silhouette: the union), assigned on the material's image node; the old image stays in the file. The picture RGB, material settings (double-sided, blend mode) and the object's name, parent and transform stay.
params:
  objects       name globs of the candidate meshes (default: every mesh with at least `min_tris` triangles and an image-texture material)
  min_tris      default 500 (only dense cards are candidates)
  max_residual_m  planarity / affine tolerance (default 0.0005 = 0.5 mm)
  max_px        the silhouette / new image longest side in px (default: the image's own size, at most 2048)
  dry_run       true: the candidates, residuals and triangle saving only
Returns: `cards` (object, triangles, residual_m, uv box, size m, material, image, coverage %), `left` (not planar / no image / no UV), triangles before / after, `images_made`.
Limits: the edge of the cut-out becomes a hard (binary) alpha at the image resolution, with no anti-aliasing; a card with holes smaller than a texel loses them; a mesh that is not a flat card (a 3D tree) is NOT a candidate. Check the picture against the original before accepting.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def tex_node(mat):
    if not (mat and mat.use_nodes):
        return None
    return next((n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image), None)


def fit(o):
    """affine map UV -> local XYZ from the vertices (first UV loop of each); returns (A 3x3 as [ [a,b,c] ...] on (u, v, 1), residual)"""
    me = o.data
    uv = me.uv_layers.active.data if me.uv_layers.active else None
    if uv is None:
        return None, None
    first = {}
    for p in me.polygons:
        for li in p.loop_indices:
            first.setdefault(me.loops[li].vertex_index, li)
    idx = list(first.items())
    U = np.array([[uv[li].uv[0], uv[li].uv[1], 1.0] for _, li in idx])
    P = np.array([me.vertices[vi].co[:] for vi, _ in idx])
    A, *_ = np.linalg.lstsq(U, P, rcond=None)
    res = float(np.abs(U @ A - P).max())
    return A, res


def raster(o, W, H, mask):
    me = o.data
    uv = me.uv_layers.active.data
    me.calc_loop_triangles()
    for t in me.loop_triangles:
        pts = np.array([[uv[li].uv[0] * W, uv[li].uv[1] * H] for li in t.loops])
        x0, x1 = int(np.floor(pts[:, 0].min() - 0.5)), int(np.ceil(pts[:, 0].max() + 0.5))
        y0, y1 = int(np.floor(pts[:, 1].min() - 0.5)), int(np.ceil(pts[:, 1].max() + 0.5))
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W - 1), min(y1, H - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        a, b, c = pts
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        w1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
        w2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
        w3 = 1 - w1 - w2
        inside = (w1 >= -1e-6) & (w2 >= -1e-6) & (w3 >= -1e-6)
        # a sliver that holds no pixel centre still marks the pixel under its centroid
        if not inside.any():
            cx, cy = int(pts[:, 0].mean()), int(pts[:, 1].mean())
            if 0 <= cx < W and 0 <= cy < H:
                mask[cy, cx] = True
            continue
        mask[y0:y1 + 1, x0:x1 + 1] |= inside


def main():
    dry = bool(L.param("dry_run", False))
    pats = L.param("objects")
    min_t = int(L.param("min_tris", 500))
    tol = float(L.param("max_residual_m", 0.0005))
    cards, left = [], []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or "blender_agent_marker" in o:
            continue
        if pats and not any(fnmatch.fnmatchcase(o.name, p) for p in pats):
            continue
        t = tris(o.data)
        if t < min_t:
            continue
        mats = [m for m in o.data.materials if m]
        tn = next((tex_node(m) for m in mats if tex_node(m)), None)
        if tn is None:
            left.append({"name": o.name, "why": "no image-texture material", "triangles": t})
            continue
        A, res = fit(o)
        if A is None:
            left.append({"name": o.name, "why": "no UV layer", "triangles": t})
            continue
        if res > tol:
            left.append({"name": o.name, "why": f"not a planar card (residual {res:.5f} m)", "triangles": t})
            continue
        uvs = np.array([l.uv[:] for l in o.data.uv_layers.active.data])
        u0, v0, u1, v1 = float(uvs[:, 0].min()), float(uvs[:, 1].min()), float(uvs[:, 0].max()), float(uvs[:, 1].max())
        mat = next(m for m in mats if tex_node(m))
        cards.append({"object": o, "A": A, "box": (u0, v0, u1, v1), "material": mat, "image": tex_node(mat).image, "triangles": t, "residual_m": res})
    if not cards:
        raise RuntimeError(f"no planar card found; left: {left[:5]}")
    rows = []
    for c in cards:
        u0, v0, u1, v1 = c["box"]
        corners = [np.array([u, v, 1.0]) @ c["A"] for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
        c["corners"] = corners
        w = float(np.linalg.norm(corners[1] - corners[0]))
        h = float(np.linalg.norm(corners[3] - corners[0]))
        rows.append({"object": c["object"].name, "triangles": c["triangles"], "residual_m": round(c["residual_m"], 8), "uv_box": [round(x, 4) for x in c["box"]],
                     "size_m": [round(w, 3), round(h, 3)], "material": c["material"].name, "image": c["image"].name})
    before = sum(c["triangles"] for c in cards)
    if dry:
        L.finish({"dry_run": True, "cards": len(cards), "triangles_before": before, "triangles_after": 2 * len(cards)}, save=False, card_rows=rows[:100], left=left[:100])
        return
    cap = L.param("max_px")
    by_mat = {}
    for c in cards:
        by_mat.setdefault(c["material"], []).append(c)
    made, cover_pct, files = [], {}, []
    for mat, cs in by_mat.items():
        img = cs[0]["image"]
        W, H = img.size
        if cap or max(W, H) > 2048:
            k = int(cap or 2048) / max(W, H)
            if k < 1:
                W, H = max(1, round(W * k)), max(1, round(H * k))
        mask = np.zeros((H, W), dtype=bool)
        for c in cs:
            raster(c["object"], W, H, mask)
        px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(img.size[1], img.size[0], 4)
        if (W, H) != (img.size[0], img.size[1]):
            ys = (np.arange(H) * img.size[1] / H).astype(int)
            xs = (np.arange(W) * img.size[0] / W).astype(int)
            px = px[ys][:, xs]
        px = px.copy()
        px[..., 3] = px[..., 3] * mask
        new = bpy.data.images.new(img.name + "_card", W, H, alpha=True)
        new.colorspace_settings.name = img.colorspace_settings.name
        new.alpha_mode = "STRAIGHT"
        new.pixels.foreach_set(px.ravel())
        new.pack()
        png = os.path.join(L.ARGS["out_dir"], f"card-{mat.name}.png".replace("/", "_"))
        new.filepath_raw = png
        new.file_format = "PNG"
        new.save()
        files.append(png)
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image == img:
                n.image = new
        made.append(new.name)
        cover_pct[mat.name] = round(float(mask.mean()) * 100, 2)
    for c in cards:
        o = c["object"]
        old = o.data
        me = bpy.data.meshes.new(old.name + "_card")
        bm = bmesh.new()
        vs = [bm.verts.new(p) for p in c["corners"]]
        f = bm.faces.new(vs)
        u0, v0, u1, v1 = c["box"]
        lay = bm.loops.layers.uv.new(old.uv_layers.active.name)
        for loop, uv in zip(f.loops, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
            loop[lay].uv = uv
        bm.to_mesh(me)
        bm.free()
        me.materials.append(c["material"])
        o.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
    bpy.context.view_layer.update()
    for r in rows:
        r["coverage_percent"] = cover_pct.get(r["material"])
    L.finish({"dry_run": False, "cards": len(cards), "triangles_before": before, "triangles_after": 2 * len(cards),
              "images_made": made}, save=True, files=files, card_rows=rows[:100], left=left[:100])


L.run(main)
