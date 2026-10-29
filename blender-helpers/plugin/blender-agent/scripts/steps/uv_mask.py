"""uv_mask — a mask picture in UV space from a bounded 3D region of the body: white where the surface inside the region is, black elsewhere. Reads only; saves no checkpoint.

For limiting a texture edit (a photo patch, a fill) to the surfaces you have validated: the mask is a plain PNG in the body's UV layout, usable as a `mask` in tex_stack. The region is the same kind as in mesh_local (a smooth falloff
or a hard edge), evaluated on the body at rest; the weight is carried to the texels across each triangle.

params:
  body        the mesh (default "body")
  uv          the UV layer (default the active one)
  size        the picture's side in px (default 2048; use the texture's size)
  region      (optional when `image` is given) sphere {c, r_mm | radii_mm, falloff_mm} | box {c, size_mm, falloff_mm} | near_bone {bone, radius_mm, falloff_mm} | group {name, min} | {"all": [...]} | {"any": [...]}; positions in MILLIMETRES, world frame (+X left, +Y back, +Z up)
  image       an existing mask picture (white = keep; a path, "out:<file>", or a Library id), MULTIPLIED with the region (or used alone when no region is given): the way to pad a mask you made yourself, e.g. photo-valid x region.
              Its values outside the islands are ignored and replaced by `pad_px` padding. Resized (nearest) to `size` if it differs; a mask from tex_stack/photo_project is in the same row order.
  mirror      true: also the x-mirrored region (union). A single selector may carry its own mirror instead, e.g. {"any": [{"sphere": {"c": [30, -80, 905], "r_mm": 18, "falloff_mm": 6}, "mirror": true}, {"sphere": {"c": [0, -90, 880], "r_mm": 20}}]} (both eyes + the nose)
  mode        "soft" (default): the region's weight 0..1 as grey; "hard": 255 where the weight is at least `threshold`, else 0
  threshold   for "hard" (default 0.5)
  grow_px     widen the white by this many px (default 0): a maximum filter, for a hard mask
  pad_px      pad the atlas margins: texels outside the islands, up to this many px from one, take the value of the nearest island texel (default 0). Use this for a SOFT mask that will be feathered or blurred afterwards: the blur then
              meets the mask's own values, not the black outside the islands, so the world-space soft edge is kept across the UV seams (both sides of a seam are the same place on the body, so they carry the same value). Give it at
              least 2-3 x the feather you will use; with it, feather_px 0 in the layer op is the cleanest route
  name        file stem (default "uv_mask"): out/<name>.png (8-bit grey, Non-Color), usable as "out:<name>.png"
Returns: pad_px, file, size, uv, mode, selected_texels and selected_pct_of_island_texels (white, soft: weight > 0.5), island_texels, region_weight_over_0 / over_0.99 (vertices), uv_bounds_of_selection ([u0, v0, u1, v1]), notes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402
import uv_common as UC  # noqa: E402
from _region import region_weight  # noqa: E402


def find_image(ref):
    if isinstance(ref, str) and ref.startswith("out:"):
        return os.path.join(L.ARGS["out_dir"], ref[4:])
    return L.resolve(ref, what="image")


def main():
    body = bpy.data.objects[L.param("body", "body")]
    if body.type != "MESH":
        raise RuntimeError("body must be a mesh")
    me = body.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None or uvn not in me.uv_layers:
        raise RuntimeError(f"no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
    region = L.param("region")
    image = L.param("image")
    if not region and not image:
        raise RuntimeError("give a region and/or an image")
    size = int(L.param("size", 2048))
    mode = L.param("mode", "soft")
    if mode not in ("soft", "hard"):
        raise RuntimeError('mode must be "soft" or "hard"')
    arm = R.find_rig()
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    M = np.array(body.matrix_world)
    V = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    W = np.zeros((n, len(body.vertex_groups)), dtype=np.float32)
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    names = [g.name for g in body.vertex_groups]
    w = np.ones(n)
    if region:
        w = region_weight(region, V, arm, W, names, False)[0]
        if L.param("mirror"):
            w = np.maximum(w, region_weight(region, V, arm, W, names, True)[0])
    if region and w.max() <= 0:
        lo, hi = V.min(0) * 1000, V.max(0) * 1000
        raise RuntimeError(f"the region selects no vertex. Positions and sizes are in MILLIMETRES, world frame; the body spans x {lo[0]:.0f}..{hi[0]:.0f}, y {lo[1]:.0f}..{hi[1]:.0f}, z {lo[2]:.0f}..{hi[2]:.0f} mm")
    tv, P3, U, tl = UC.uv_arrays(me, uvn)  # tv: the vertex index of each triangle corner
    tid, bary = UC.raster_ids(U, size)
    inside = tid >= 0
    ys, xs = np.nonzero(inside)
    ti = tid[ys, xs]
    b1, b2 = bary[ys, xs, 0], bary[ys, xs, 1]
    wt = w[tv[ti]]  # (N, 3)
    val = wt[:, 0] * (1 - b1 - b2) + wt[:, 1] * b1 + wt[:, 2] * b2
    img = np.zeros((size, size), np.float32)
    thr = float(L.param("threshold", 0.5))
    img[ys, xs] = np.clip(val, 0, 1)
    if image:  # an existing mask picture (white = keep), multiplied in; only its values INSIDE the islands are used
        pic = UC.load_image(find_image(image))
        m = pic[..., :3].mean(-1)[::-1]  # row 0 = v 0, like the raster
        if m.shape != (size, size):
            yy = np.minimum((np.arange(size) * m.shape[0] / size).astype(int), m.shape[0] - 1)
            xx = np.minimum((np.arange(size) * m.shape[1] / size).astype(int), m.shape[1] - 1)
            m = m[yy][:, xx]
        img = img * m.astype(np.float32)
    if mode == "hard":
        img = (img >= thr).astype(np.float32)
    for _ in range(int(L.param("grow_px", 0))):
        g = img.copy()
        g[1:, :] = np.maximum(g[1:, :], img[:-1, :])
        g[:-1, :] = np.maximum(g[:-1, :], img[1:, :])
        g[:, 1:] = np.maximum(g[:, 1:], img[:, :-1])
        g[:, :-1] = np.maximum(g[:, :-1], img[:, 1:])
        img = g
    pad = int(L.param("pad_px", 0))
    if pad > 0:
        rgb, _valid = UC.dilate_fill(np.repeat(img[..., None], 3, axis=2), inside, pad)
        img = rgb[..., 0]
    name = L.param("name", "uv_mask")
    os.makedirs(L.ARGS["out_dir"], exist_ok=True)
    path = os.path.join(L.ARGS["out_dir"], f"{name}.png")
    # raster row 0 is v = 0; the file's top row is v = 1 (as photo_project writes its sheets)
    UC.save_image(np.repeat(img[::-1, :, None], 3, axis=2), path, "Non-Color", "PNG")
    sel = (img > 0.5) & inside
    uvs = [round(float(x), 4) for x in ((xs[sel[ys, xs]].min() / size, ys[sel[ys, xs]].min() / size, xs[sel[ys, xs]].max() / size, ys[sel[ys, xs]].max() / size) if sel.any() else (0, 0, 0, 0))]
    L.finish({"file": os.path.basename(path), "size": size, "uv": uvn, "mode": mode, "pad_px": pad, "selected_texels": int(sel.sum()), "selected_pct_of_island_texels": round(float(sel.sum() / max(inside.sum(), 1) * 100), 2),
              "island_texels": int(inside.sum()), "region_weight_over_0": int((w > 0).sum()), "region_weight_over_0.99": int((w > 0.99).sum()), "uv_bounds_of_selection": uvs,
              "notes": ["grey = the region's weight" if mode == "soft" else "white = weight at least the threshold"]}, files=[path])


L.run(main)
