"""photo_project — project video frames (perspective photos) onto the posed body copy and write a texture in the body's UV layout, with masks, coverage and failure maps. Saves a checkpoint.

For each photo the camera is the bundle's reconstructed camera for that instant (camera-reference.json): position in the reference's Blender coordinates, axes = the columns of its camera-to-page rotation carried through the
page-to-Blender transform (x right, y down, z forward), focal lengths fx = fx_n * width and fy = fy_n * height, principal point at the centre. THE CAMERA IS A HINT: check the reproject picture (the posed copy's points drawn over
the photo) before trusting a projection; `shift` and `focal_scale` correct it.
Every texel of the UV sheet is a point on the posed copy (barycentric on its UV triangle); a photo reaches it when the point is inside the image, faces the camera (cosine over `min_cos`) and is not hidden by another part of
the copy (a ray from the camera hits that point). The colour is the photo's, weighted by cos^2 and a fall-off toward the image border; several photos are blended by those weights.
Needs the posed copy made by pose_fit (the same topology and UV layers as the body).

params:
  bundle      the bundle folder or zip (see reference_import) (camera-reference.json, video-frames/)
  photos      list of {"time_s": 0.5, "image": "video-frames/000500ms.jpg"} (image: relative to the bundle, absolute, a Library id, or {"library_id": id}); the camera is the entry of that instant; optional per photo
              "shift": [dx, dy] px (move the projection), "shift_space": "proxy" (default) | "image", "focal_scale": 1.0, "weight": 1.0
              The camera is the PROXY video's (camera-reference.json: normalised focal length and principal point, proxy_size 1080 x 1920): it is scaled to the photo by the photo's size over the proxy's, per axis, so the photo must be
              the same frame and crop as the proxy (a crop or a different aspect shifts everything). `shift` is in the PROXY's pixels by default, so for a photo twice the proxy's size a shift of [0, 145] already moves it 290 of the photo's
              pixels; "shift_space": "image" gives it in the photo's own pixels. The report's `camera` shows image_size, scale_to_image, principal_point_px and shift_applied_image_px.
  mesh        the posed copy (default "body_posed")
  uv          the UV layer (default the body's active layer)
  size        texture size px (default 1024)
  min_cos     faces turned away more than this are not seen (default 0.2): the cosine of the angle between the surface normal and the direction to the camera
  soft        true (default): a CONTINUOUS confidence instead of seen / not seen: mask-<n>.png is then the confidence in grey (0..1), and the colour blend is weighted by it, so photos fade out smoothly where the surface turns away or is nearly hidden.
              The confidence is a ramp in the cosine from min_cos up over `fade_cos` (default 0.15) times a ramp in the occlusion distance (how far the first thing the camera ray meets is from the texel's own point, from 4 mm over
              `fade_occlusion_mm`, default 6). It is computed per texel from interpolated normals, so it is the same on both sides of a UV seam. false: all-or-nothing visibility
  normals     "smooth" (default): the cosine uses the vertex normals interpolated across each triangle (averaged over the vertices at one place); "face": the flat face normal (every triangle is then its own island of confidence)
  border_px   fall-off width at the image border (default 40)
  name        file stem in out/ (default "<job>-proj")
Writes out/<name>-colour.png (the blended colour, magenta where no photo reached), <name>-coverage.png (total weight, a heat map), <name>-failure.png (texels inside islands that no photo reached: red = hidden,
orange = faces away, yellow = outside the image, grey = the sheet outside islands), <name>-mask-<n>.png (what photo n sees) and reproject-<n>.png (the photo with the copy's points over it).
Returns: photos (per photo: camera used, seen_pct of island texels, hidden_pct, facing_away_pct, outside_image_pct), coverage_pct (island texels reached by at least one photo), overlap_pct (reached by two or more), image sizes, notes.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402
import _bundle as B  # noqa: E402
from _photocam import camera_for, project  # noqa: E402
import uv_common as UC  # noqa: E402


def sample(img, u, v):
    """bilinear sample of img (H, W, 4) at pixel coordinates (u across, v down, pixel centres at +0.5)"""
    h, w = img.shape[:2]
    x, y = np.clip(u - 0.5, 0, w - 1.001), np.clip(v - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def heat(x):
    x = np.clip(x, 0, 1)
    return np.stack([np.clip(2 * x - 1, 0, 1), np.clip(1 - np.abs(2 * x - 1), 0, 1), np.clip(1 - 2 * x, 0, 1)], 1)


def main():
    b = L.param("bundle")
    if not b:
        raise RuntimeError("bundle is required")
    d = B.bundle(b)
    ref = json.loads((d / "reference.json").read_text())
    cams = json.loads((d / "camera-reference.json").read_text())
    mesh = bpy.data.objects.get(L.param("mesh", "body_posed"))
    if mesh is None or mesh.type != "MESH":
        raise RuntimeError("no posed copy: run pose_fit first")
    me = mesh.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None or uvn not in me.uv_layers:
        raise RuntimeError(f"no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
    photos = L.param("photos") or []
    if not photos:
        raise RuntimeError('give photos: [{"time_s": 0.5, "image": "video-frames/000500ms.jpg"}]')
    size = int(L.param("size", 1024))
    min_cos = float(L.param("min_cos", 0.2))
    soft = bool(L.param("soft", True))
    fade_cos = float(L.param("fade_cos", 0.15))
    fade_occ = float(L.param("fade_occlusion_mm", 6)) / 1000
    nmode = L.param("normals", "smooth")
    if nmode not in ("smooth", "face"):
        raise RuntimeError('normals must be "smooth" or "face"')
    border = float(L.param("border_px", 40))
    name = L.param("name", f"{L.ARGS['job']}-proj")
    tv, P3, U, tl = UC.uv_arrays(me, uvn)
    tid, bary = UC.raster_ids(U, size)
    ys, xs = np.nonzero(tid >= 0)
    ti = tid[ys, xs]
    b1, b2 = bary[ys, xs, 0], bary[ys, xs, 1]
    b0 = 1 - b1 - b2
    tri = P3[ti]  # (N, 3, 3)
    pts = tri[:, 0] * b0[:, None] + tri[:, 1] * b1[:, None] + tri[:, 2] * b2[:, None]
    e1, e2 = tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    nrm = np.cross(e1, e2)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    if nmode == "smooth":
        # the surface normal at the texel, interpolated between the corners' vertex normals (averaged over the vertices at one place, so a UV seam does not break it): a continuous cosine,
        # not one value per triangle (a face normal makes every triangle a flat island of confidence)
        nv = len(me.vertices)
        vn = np.empty(nv * 3)
        me.vertex_normals.foreach_get("vector", vn)
        vn = vn.reshape(-1, 3)
        vco = np.empty(nv * 3)
        me.vertices.foreach_get("co", vco)
        vco = vco.reshape(-1, 3)
        _, gid = np.unique(np.round(vco / 1e-5).astype(np.int64), axis=0, return_inverse=True)
        gid = gid.ravel()
        gs = np.zeros((int(gid.max()) + 1, 3))
        np.add.at(gs, gid, vn)
        vn = gs[gid] / np.maximum(np.linalg.norm(gs[gid], axis=1, keepdims=True), 1e-12)
        sm = vn[tv[ti, 0]] * b0[:, None] + vn[tv[ti, 1]] * b1[:, None] + vn[tv[ti, 2]] * b2[:, None]
        sm /= np.maximum(np.linalg.norm(sm, axis=1, keepdims=True), 1e-12)
        flip = (sm * nrm).sum(1) < 0  # keep the face normal's side where the two disagree wildly (a stored-the-other-way-round face)
        nrm = np.where(flip[:, None], nrm, sm)
    nisl = len(pts)
    bm_verts = [Vector(v.co) for v in me.vertices]
    me.calc_loop_triangles()
    polys = [tuple(t.vertices) for t in me.loop_triangles]
    bvh = BVHTree.FromPolygons(bm_verts, polys)
    acc_c = np.zeros((nisl, 3))
    acc_w = np.zeros(nisl)
    seen_n = np.zeros(nisl, int)
    reasons = np.zeros(nisl, int)  # the worst reason a texel failed in every photo: 0 reached, 1 hidden, 2 away, 3 outside the image
    all_fail = np.ones(nisl, bool)
    info, files = [], []
    outd = L.ARGS["out_dir"]
    for pi, ph in enumerate(photos):
        shift = tuple(ph.get("shift", (0, 0)))
        cam = camera_for(cams, ref, float(ph["time_s"]), (0, 0), float(ph.get("focal_scale", 1.0)))
        if L.is_id(ph["image"]) or isinstance(ph["image"], dict):
            img = UC.load_image(L.resolve(ph["image"], what=f"photos[{pi}].image"))
        else:
            ip = Path(ph["image"])
            img = UC.load_image(str(ip if ip.is_absolute() else d / ip))
        proxy = (cam["W"], cam["H"])
        sx, sy = img.shape[1] / cam["W"], img.shape[0] / cam["H"]
        if ph.get("shift_space", "proxy") not in ("proxy", "image"):
            raise RuntimeError('shift_space must be "proxy" or "image"')
        # the camera is the proxy video's: its focal length and principal point are in the proxy's pixels and are scaled to this image by the size ratio, per axis (so the
        # image must be the same frame, same crop, as the proxy). `shift` is in the proxy's pixels by default, so it is scaled too; "image" means pixels of THIS image.
        shift_img = (shift[0] * sx, shift[1] * sy) if ph.get("shift_space", "proxy") == "proxy" else shift
        cam["fx"] *= sx
        cam["fy"] *= sy
        cam["cx"] = cam["cx"] * sx + shift_img[0]
        cam["cy"] = cam["cy"] * sy + shift_img[1]
        cam["W"], cam["H"] = img.shape[1], img.shape[0]
        u, v, z = project(pts, cam)
        inside = (z > 0.05) & (u >= 0) & (u < cam["W"]) & (v >= 0) & (v < cam["H"])
        tocam = cam["pos"] - pts
        dist = np.linalg.norm(tocam, axis=1)
        cosv = (nrm * tocam).sum(1) / np.maximum(dist, 1e-9)
        facing = cosv >= min_cos
        cand = inside & facing
        vis = np.zeros(nisl, bool)
        dd = np.full(nisl, np.inf)  # how far the first thing the ray meets is from the texel's own point (0 = it is the texel itself)
        origin = Vector(cam["pos"])
        idx = np.where(cand)[0]
        for i in idx:
            dv = (Vector(pts[i]) - origin)
            dl = dv.length
            hit = bvh.ray_cast(origin, dv / dl, dl + 0.002)
            if hit[0] is not None:
                dd[i] = (hit[0] - Vector(pts[i])).length
            vis[i] = hit[0] is not None and dd[i] < 0.004
        if soft:
            # a confidence 0..1 in surface space: a ramp in the cosine above min_cos (fade_cos wide) times a ramp in the occlusion distance above 4 mm (fade_occlusion_mm wide)
            def ss(x):
                x = np.clip(x, 0, 1)
                return x * x * (3 - 2 * x)
            conf = np.where(cand, ss((cosv - min_cos) / max(fade_cos, 1e-6)) * (1 - ss((dd - 0.004) / max(fade_occ, 1e-6))), 0.0)
            conf = np.where(np.isfinite(dd), conf, 0.0)
            seen = conf >= 0.5
            act = conf > 1e-3
        else:
            conf = vis.astype(float)
            seen = vis
            act = vis
        hidden = cand & ~vis
        away = inside & ~facing
        out_img = ~inside
        info.append({"photo": pi, "time_s": cam["t"], "image": str(ph["image"]), "camera": {"position": [round(float(x), 3) for x in cam["pos"]], "fx_px": round(cam["fx"], 1), "fy_px": round(cam["fy"], 1), "principal_point_px": [round(float(cam["cx"]), 1), round(float(cam["cy"]), 1)],
                   "image_size": [cam["W"], cam["H"]], "proxy_size": list(proxy), "scale_to_image": [round(sx, 4), round(sy, 4)], "shift_given": list(shift), "shift_space": ph.get("shift_space", "proxy"), "shift_applied_image_px": [round(float(shift_img[0]), 1), round(float(shift_img[1]), 1)]},
                     "seen_pct": round(float(seen.mean() * 100), 1), "hidden_pct": round(float(hidden.mean() * 100), 1), "facing_away_pct": round(float(away.mean() * 100), 1), "outside_image_pct": round(float(out_img.mean() * 100), 1)})
        w = np.zeros(nisl)
        if act.any():
            edge = np.minimum.reduce([u[act], cam["W"] - u[act], v[act], cam["H"] - v[act]])
            fall = np.clip(edge / max(border, 1e-6), 0, 1)
            w[act] = (cosv[act] ** 2) * (fall * fall * (3 - 2 * fall)) * float(ph.get("weight", 1.0)) * (conf[act] if soft else 1.0)
            col = sample(img, u[act], v[act])[:, :3]
            acc_c[act] += col * w[act, None]
            acc_w[act] += w[act]
            seen_n[act] += 1
        r = np.where(hidden, 1, np.where(away, 2, np.where(out_img, 3, 0)))
        reasons = np.where(seen, 0, np.maximum(reasons, np.where(r == 0, reasons, r)))
        all_fail &= ~seen
        m = np.zeros((size, size, 3), np.float32)
        if soft:
            m[ys[act], xs[act]] = np.repeat(np.clip(conf[act], 0, 1)[:, None], 3, axis=1)  # the confidence itself, grey 0..1, in the sheet's layout
        else:
            m[ys[seen], xs[seen]] = (1, 1, 1)
        p = os.path.join(outd, f"{name}-mask-{pi}.png")
        UC.save_image(m[::-1], p, "Non-Color")
        files.append(p)
        # the reproject check: the copy's vertices over the photo
        vv = np.array([x.co[:] for x in me.vertices])
        uu, vv2, zz = project(vv, cam)
        ok = (zz > 0.05) & (uu >= 0) & (uu < cam["W"]) & (vv2 >= 0) & (vv2 < cam["H"])
        chk = img[..., :3].copy()
        for dx in (0, 1):
            for dy in (0, 1):
                chk[np.clip(vv2[ok].astype(int) + dy, 0, cam["H"] - 1), np.clip(uu[ok].astype(int) + dx, 0, cam["W"] - 1)] = (1, 0, 0)
        p = os.path.join(outd, f"reproject-{pi}.png")
        UC.save_image(chk, p, "sRGB")
        files.append(p)
    colour = np.zeros((size, size, 3), np.float32)
    colour[...] = (1, 0, 1)
    got = acc_w > 1e-9
    colour[ys[got], xs[got]] = (acc_c[got] / acc_w[got, None]).astype(np.float32)
    p = os.path.join(outd, f"{name}-colour.png")
    UC.save_image(colour[::-1], p, "sRGB")
    files.append(p)
    cov = np.zeros((size, size, 3), np.float32)
    cov[ys, xs] = heat(acc_w / max(np.percentile(acc_w[got], 95) if got.any() else 1, 1e-9))
    p = os.path.join(outd, f"{name}-coverage.png")
    UC.save_image(cov[::-1], p, "sRGB")
    files.append(p)
    fail = np.full((size, size, 3), 0.15, np.float32)
    colmap = {0: (0.1, 0.8, 0.2), 1: (1, 0.1, 0.1), 2: (1, 0.55, 0.0), 3: (1, 0.9, 0.1)}
    for k, cvals in colmap.items():
        sel = (reasons == k) & ~got if k else got
        fail[ys[sel], xs[sel]] = cvals
    p = os.path.join(outd, f"{name}-failure.png")
    UC.save_image(fail[::-1], p, "sRGB")
    files.append(p)
    L.finish({"photos": info, "coverage_pct": round(float(got.mean() * 100), 1), "overlap_pct": round(float((seen_n >= 2).mean() * 100), 1), "island_texels": int(nisl), "size": size,
              "files": [os.path.basename(f) for f in files], "uv": uvn, "mesh": mesh.name, "notes": ["the camera is a hint: check reproject-<n>.png before trusting the projection"]}, files=files, save=False)


L.run(main)
