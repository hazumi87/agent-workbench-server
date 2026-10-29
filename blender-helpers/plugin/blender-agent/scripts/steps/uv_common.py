"""uv_common — shared helpers of uv_edit, uv_check and uv_rebake (not a verb): UV islands, per-triangle stretch and density, coverage rasters, the layout drawing."""
import numpy as np


def uv_arrays(me, layer):
    """per loop-triangle: vertex indices (T,3), 3D positions (T,3,3), uv (T,3,2) for the UV layer `layer`"""
    me.calc_loop_triangles()
    nl = len(me.loops)
    uv = np.empty(nl * 2)
    me.uv_layers[layer].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    nv = len(me.vertices)
    co = np.empty(nv * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    tl = np.array([t.loops[:] for t in me.loop_triangles])
    tv = np.array([t.vertices[:] for t in me.loop_triangles])
    return tv, co[tv], uv[tl], tl


def islands(me, layer, eps=1e-6):
    """island id per polygon, by UV connectivity (two faces share an island when they share an edge whose UVs coincide at both ends)"""
    uvd = me.uv_layers[layer].data
    nl = len(me.loops)
    uv = np.empty(nl * 2)
    uvd.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    parent = list(range(len(me.polygons)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    edge_loops = {}
    for p in me.polygons:
        for li in p.loop_indices:
            l = me.loops[li]
            a, b = l.vertex_index, me.loops[p.loop_start + (li - p.loop_start + 1) % p.loop_total].vertex_index
            edge_loops.setdefault((min(a, b), max(a, b)), []).append((p.index, li, p.loop_start + (li - p.loop_start + 1) % p.loop_total, a))
    for k, lst in edge_loops.items():
        if len(lst) != 2:
            continue
        (p0, a0, a1, v0), (p1, b0, b1, v1) = lst
        # edge goes v0->next in p0 and v1->next in p1; match the UV at the same vertex
        pa = {me.loops[a0].vertex_index: uv[a0], me.loops[a1].vertex_index: uv[a1]}
        pb = {me.loops[b0].vertex_index: uv[b0], me.loops[b1].vertex_index: uv[b1]}
        if all(np.abs(pa[v] - pb[v]).max() < eps for v in pa):
            r0, r1 = find(p0), find(p1)
            if r0 != r1:
                parent[r0] = r1
    ids, lab = {}, np.zeros(len(me.polygons), int)
    for i in range(len(me.polygons)):
        lab[i] = ids.setdefault(find(i), len(ids))
    return lab, len(ids)


def tri_stretch(P, U):
    """per triangle: 3D area, UV area, and the stretch (largest / smallest singular value of the 3D->UV map)"""
    e1, e2 = P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]
    n = np.cross(e1, e2)
    a3 = np.linalg.norm(n, axis=1) / 2
    x = e1 / np.maximum(np.linalg.norm(e1, axis=1, keepdims=True), 1e-12)
    nn = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    y = np.cross(nn, x)
    p1 = np.stack([(e1 * x).sum(1), (e1 * y).sum(1)], 1)
    p2 = np.stack([(e2 * x).sum(1), (e2 * y).sum(1)], 1)
    u1, u2 = U[:, 1] - U[:, 0], U[:, 2] - U[:, 0]
    Pm = np.stack([p1, p2], 2)  # (T,2,2) columns p1,p2
    Um = np.stack([u1, u2], 2)
    det = Pm[:, 0, 0] * Pm[:, 1, 1] - Pm[:, 0, 1] * Pm[:, 1, 0]
    ok = np.abs(det) > 1e-14
    inv = np.zeros_like(Pm)
    inv[ok, 0, 0], inv[ok, 1, 1] = Pm[ok, 1, 1] / det[ok], Pm[ok, 0, 0] / det[ok]
    inv[ok, 0, 1], inv[ok, 1, 0] = -Pm[ok, 0, 1] / det[ok], -Pm[ok, 1, 0] / det[ok]
    J = Um @ inv
    s = np.linalg.svd(J, compute_uv=False)
    a2 = np.abs(u1[:, 0] * u2[:, 1] - u1[:, 1] * u2[:, 0]) / 2
    return a3, a2, np.where(ok & (s[:, 1] > 1e-12), s[:, 0] / np.maximum(s[:, 1], 1e-12), np.inf)


def raster_counts(U, size):
    """how many UV triangles cover each texel of a size x size grid (texel centres)"""
    cnt = np.zeros((size, size), np.int32)
    px = U * size
    for t in range(len(U)):
        a, b, c = px[t]
        x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0])))), int(min(size - 1, np.ceil(max(a[0], b[0], c[0]))))
        y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1])))), int(min(size - 1, np.ceil(max(a[1], b[1], c[1]))))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
        l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
        m = (l1 >= 0) & (l2 >= 0) & (1 - l1 - l2 >= 0)
        cnt[y0:y1 + 1, x0:x1 + 1] += m
    return cnt


def draw_layout(U, tri_island, size, path):
    """write the UV layout as a PNG: a dark sheet, each island's triangle edges in its own colour (v up)"""
    import bpy
    img = np.zeros((size, size, 4), np.float32)
    img[..., 3] = 1
    img[..., :3] = 0.06
    rng = np.random.default_rng(5)
    cols = 0.35 + 0.65 * rng.random((int(tri_island.max()) + 1, 3))
    for t in range(len(U)):
        c = cols[tri_island[t]]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            p, q = U[t, a] * size, U[t, b] * size
            n = int(max(abs(q[0] - p[0]), abs(q[1] - p[1]))) + 2
            xs = np.clip(np.linspace(p[0], q[0], n).astype(int), 0, size - 1)
            ys = np.clip(np.linspace(p[1], q[1], n).astype(int), 0, size - 1)
            img[ys, xs, :3] = c
    im = bpy.data.images.new("uv-layout", size, size, alpha=False)
    im.pixels.foreach_set(img.ravel())
    im.filepath_raw = path
    im.file_format = "PNG"
    im.save()
    bpy.data.images.remove(im)


def raster_ids(U, size):
    """per texel of a size x size sheet (row 0 = v 0): the UV triangle covering it (-1 = none) and its barycentric coordinates (b1, b2) for the 2nd and 3rd corner"""
    tid = np.full((size, size), -1, np.int32)
    bary = np.zeros((size, size, 2), np.float32)
    px = U * size
    for t in range(len(U)):
        a, b, c = px[t]
        x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0])))), int(min(size - 1, np.ceil(max(a[0], b[0], c[0]))))
        y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1])))), int(min(size - 1, np.ceil(max(a[1], b[1], c[1]))))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d  # weight of corner a
        l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d  # weight of corner b
        m = (l1 >= -1e-6) & (l2 >= -1e-6) & (1 - l1 - l2 >= -1e-6)
        sub = tid[y0:y1 + 1, x0:x1 + 1]
        sub[m] = t
        bb = bary[y0:y1 + 1, x0:x1 + 1]
        bb[m, 0] = l2[m]
        bb[m, 1] = (1 - l1 - l2)[m]
    return tid, bary


def load_image(path):
    """an image file as float RGBA, row 0 = TOP (as stored in the file), values as stored (sRGB-encoded for an 8-bit file)"""
    import bpy
    im = bpy.data.images.load(path)
    w, h = im.size
    a = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(a)
    bpy.data.images.remove(im)
    return a.reshape(h, w, 4)[::-1].copy()


def save_image(arr, path, colorspace="sRGB", fmt="PNG", quality=90):
    """arr (H, W, 3 or 4) float, row 0 = top, written as stored (no colour conversion)"""
    import bpy
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), arr.dtype)], axis=2)
    im = bpy.data.images.new("tmp-save", w, h, alpha=True, float_buffer=False)
    im.colorspace_settings.name = {"Linear": "Linear Rec.709"}.get(colorspace, colorspace)
    im.pixels.foreach_set(np.ascontiguousarray(arr[::-1]).astype(np.float32).ravel())
    im.filepath_raw = path
    im.file_format = fmt
    im.save()
    bpy.data.images.remove(im)


def remap_z(v0, anchors_mm, full_mm=130, zero_mm=200, smooth_mm=25, centre_x_mm=None):
    """the height remap of mesh_proportion on an array of points (metres): returns the moved points. anchors_mm = [[from, to], ...]"""
    fr = np.array([float(a[0]) for a in anchors_mm]) / 1000.0
    to = np.array([float(a[1]) for a in anchors_mm]) / 1000.0
    if len(fr) < 2 or (np.diff(fr) <= 0).any() or (np.diff(to) <= 0).any():
        raise RuntimeError("anchors must be at least two [from_mm, to_mm] pairs, increasing in both")
    full, zero, sm = float(full_mm) / 1000.0, float(zero_mm) / 1000.0, float(smooth_mm) / 1000.0
    cx = float(centre_x_mm) / 1000.0 if centre_x_mm is not None else float((v0[:, 0].max() + v0[:, 0].min()) / 2)
    zg = np.arange(float(v0[:, 2].min()) - 0.1, float(v0[:, 2].max()) + 0.3, 0.001)
    disp = np.interp(zg, fr, to - fr)
    disp[zg < fr[0]] = (to - fr)[0]
    disp[zg > fr[-1]] = (to - fr)[-1]
    if sm > 0:
        k = np.arange(-int(3 * sm * 1000), int(3 * sm * 1000) + 1) / 1000.0
        w = np.exp(-0.5 * (k / (sm / 2)) ** 2)
        w /= w.sum()
        pad = np.concatenate([np.full(len(k) // 2, disp[0]), disp, np.full(len(k) // 2, disp[-1])])
        disp = np.convolve(pad, w, mode="valid")[: len(zg)]
    wx = np.clip((np.abs(v0[:, 0] - cx) - full) / (zero - full), 0, 1)
    wx = 1 - wx * wx * (3 - 2 * wx)
    v1 = v0.copy()
    v1[:, 2] = v0[:, 2] + np.interp(v0[:, 2], zg, disp) * wx
    return v1


def dilate_fill(img, valid, px):
    """fill the invalid texels from the nearest valid ones, one ring at a time, up to px. Only the texels on the front of each ring are touched (the sheet's edges do not wrap)."""
    img = img.copy()
    valid = valid.copy()
    h, w = valid.shape
    flat = img.reshape(h * w, -1)
    vflat = valid.reshape(h * w)
    offs = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy, dx) != (0, 0)]
    for _ in range(int(px)):
        near = np.zeros_like(valid)
        near[1:, :] |= valid[:-1, :]
        near[:-1, :] |= valid[1:, :]
        near[:, 1:] |= valid[:, :-1]
        near[:, :-1] |= valid[:, 1:]
        near[1:, 1:] |= valid[:-1, :-1]
        near[:-1, :-1] |= valid[1:, 1:]
        near[1:, :-1] |= valid[:-1, 1:]
        near[:-1, 1:] |= valid[1:, :-1]
        idx = np.flatnonzero(near & ~valid)
        if not len(idx):
            break
        y, x = idx // w, idx % w
        acc = np.zeros((len(idx), flat.shape[1]), flat.dtype)
        cnt = np.zeros(len(idx), np.float32)
        for dy, dx in offs:
            ok = (y + dy >= 0) & (y + dy < h) & (x + dx >= 0) & (x + dx < w)
            ni = np.where(ok, idx + dy * w + dx, 0)
            v = vflat[ni] & ok
            acc += flat[ni] * v[:, None]
            cnt += v
        flat[idx] = acc / np.maximum(cnt, 1)[:, None]
        vflat[idx] = True
    return img, valid
