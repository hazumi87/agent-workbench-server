"""photo_free — paint a mesh's UV texture from ANY photograph (not a video frame): register the photo to the mesh from landmark pairs you give, project it into the UV layout with confidence masks, and write colour (+ optional roughness and a weak normal map) as pictures. Saves no checkpoint.

For a hand photographed from the back, for instance: you give landmark pairs (a point on the mesh and where that point is in the photo: fingertips, knuckles, wrist corners, nail centres). The verb
  1. solves an affine camera (a parallel projection: the photo is treated as taken from far away along one direction) from the pairs: px = A . [X, Y, Z, 1],
  2. warps the remaining mismatch away: a thin-plate warp of the photo's pixel positions that makes the landmarks land exactly (so the photo's fingers and nails are bent onto the model's, whose shape differs),
  3. for every UV texel: the surface point, is it facing the camera (cos), is it hidden by another part of the mesh (a ray along the viewing direction), then samples the photo there with a confidence.
Texels the photo does not reach are filled with the photo's average skin colour near them (`fill`) so the texture is complete, and are listed in the failure picture. The photo is never modified; the registration (camera, warp, landmarks) is returned so the same projection can be repeated.

params:
  mesh      the mesh to paint (default "hand_L", also works on the joined body: restrict with `faces_of_slot` or just give its own UV layer)
  uv        the UV layer to write in (default "HandUV" if present, else the active one)
  photos    list of {"image": file | Library id | {"library_id": id} | "out:<file>", "points": [...], "view_from": [x, y, z], "weight": 1.0}
            points: {"name": "tip_index", "px": [u, v], and ONE of "vertex": n | "mm": [x, y, z] (world mm, a point ON the surface) | "joint": "LeftHandIndex3", "at": "tail" | "head" (a bone's end, from the armature `armature`, moved
            to the surface (optionally "back_mm": 5 first moves the point that far along the bone toward its other end: a bone's tail is the middle of the fingertip's volume, so for a NAIL CENTRE give the last bone's tail with back_mm about 4-6; the ray then lands on the DORSAL surface, not the tip cap): the first mesh hit along the direction toward the camera `view_from`)}. px: pixels of the photo, origin top-left, u right, v down. At least 4 points not all on one line (6 or more is better; more than 8 gives the warp something to do).
            view_from: the direction from the mesh toward the camera (world), roughly: for the back of a hand with palms down it is [0, 0, 1] with palm [0, 0, -1] ... default: opposite to the palm (the back of the hand)
  size      texture size px (default 1024; the occlusion ray per texel is the slow part)
  armature  the rig, for "joint" points (default "rig")
  warp      true (default): thin-plate warp of the residuals; false: the affine camera only
  skin_mask true (default): only skin-coloured photo pixels paint (a chroma test in YCbCr, softened): the table, the black cuff, the sleeve, shadows at the edge of a finger are skipped and filled from what is around them. false: every pixel
  min_cos   faces turned away more than this are not seen (default 0.3: grazing surfaces are filled, not smeared); fade_cos (default 0.3) is the ramp above it
  edge_erode_px  the skin mask is eroded by this many photo pixels (default 20; at 4032 px wide) so the hand's shadowed grazing edge and the contact shadow do not paint
  feather_px  how softly the painted area gives way to the fill (default 48 texels at 1024)
  rim_erode_texels  the painted area is shrunk by this many texels (default 8) before it is used, so its shaded rim does not leave a dark halo in the fill
  fill      "mean" (default): unreached texels take the local average of the painted texels around them; "global": the photo's overall average skin colour everywhere (no local variation); "none": magenta where no photo reached (the picture is then not usable as a texture)
  pad_px    pad the colour past the island edges by this many texels (default 8) so the mip-maps and seams do not show
  roughness [centre, detail]: also write a roughness picture: `centre` (default 0.55) plus the photo's luminance detail (high-pass) times `detail` (default 0.15); [] or false: none
  normal    strength (default 0.12, 0 = none): a weak tangent-space normal picture (OpenGL) from the photo's luminance high-pass. It is NOT measured relief (the photo's lighting and hair are in it): inspect with the normal map on and off
  highpass_px  the blur radius in texels that separates the detail from the lighting (default 12)
  name      file stem in out/ (default "<job>-paint")
Writes out/<name>-colour.png (sRGB), <name>-coverage.png, <name>-failure.png (red hidden, orange facing away, yellow outside the photo, grey outside islands), <name>-roughness.png and <name>-normal.png (Non-Color) when asked, and reproject-<n>.png (the photo with the mesh's vertices and the landmarks over it).
Returns: per photo the camera (the matrix A, the viewing direction), landmark residuals in px before / after the warp, coverage; the files; notes.
Then material_assign (body: the mesh, uv: the layer) puts the pictures on it as a full PBR material, with masters kept.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402
import uv_common as UC  # noqa: E402


def sample(img, u, v):
    h, w = img.shape[:2]
    x, y = np.clip(u - 0.5, 0, w - 1.001), np.clip(v - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy


def tps_fit(src, dst, lam=1e-3):
    """thin-plate spline taking the 2D points src to dst: returns a function"""
    n = len(src)

    def U(r2):
        return np.where(r2 > 0, 0.5 * r2 * np.log(np.maximum(r2, 1e-12)), 0.0)
    d2 = ((src[:, None, :] - src[None, :, :]) ** 2).sum(-1)
    K = U(d2) + lam * np.eye(n) * (np.ptp(src) ** 2 + 1)
    Pm = np.hstack([np.ones((n, 1)), src])
    A = np.zeros((n + 3, n + 3))
    A[:n, :n] = K
    A[:n, n:] = Pm
    A[n:, :n] = Pm.T
    rhs = np.zeros((n + 3, 2))
    rhs[:n] = dst
    sol = np.linalg.solve(A, rhs)
    wts, aff = sol[:n], sol[n:]

    def f(q):
        r2 = ((q[:, None, :] - src[None, :, :]) ** 2).sum(-1)
        return U(r2) @ wts + np.hstack([np.ones((len(q), 1)), q]) @ aff
    return f


def blur(a, r):
    """a cheap separable box blur (3 passes ~ gaussian) of (H, W) or (H, W, C)"""
    r = int(max(r, 1))
    out = a.astype(np.float32)
    for _ in range(3):
        for ax in (0, 1):
            c = np.cumsum(np.pad(out, [(r + 1, r) if k == ax else (0, 0) for k in range(out.ndim)], mode="edge"), axis=ax)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[ax]), axis=ax)
            lo = np.take(c, np.arange(0, c.shape[ax] - 2 * r - 1), axis=ax)
            out = (hi - lo) / (2 * r + 1)
    return out


def main():
    mesh = bpy.data.objects.get(L.param("mesh", "hand_L"))
    if mesh is None or mesh.type != "MESH":
        raise RuntimeError("no such mesh (give `mesh`)")
    me = mesh.data
    uvn = L.param("uv") or ("HandUV" if "HandUV" in me.uv_layers else (me.uv_layers.active.name if me.uv_layers.active else None))
    if uvn is None or uvn not in me.uv_layers:
        raise RuntimeError(f"no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
    photos = L.param("photos") or []
    if not photos:
        raise RuntimeError('give photos: [{"image": ..., "points": [{"name": "tip_index", "px": [u, v], "vertex": 12}, ...]}]')
    size = int(L.param("size", 1024))
    min_cos = float(L.param("min_cos", 0.3))
    fade_cos = float(L.param("fade_cos", 0.3))
    do_warp = bool(L.param("warp", True))
    pad_px = int(L.param("pad_px", 8))
    name = L.param("name", f"{L.ARGS['job']}-paint")
    hp_px = int(L.param("highpass_px", 12))
    arm = bpy.data.objects.get(L.param("armature", "rig"))
    mw = np.array(mesh.matrix_world)
    nv = len(me.vertices)
    co = np.empty(nv * 3)
    me.vertices.foreach_get("co", co)
    Pw = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
    me.calc_loop_triangles()
    tv, _, U, tl = UC.uv_arrays(me, uvn)
    P3 = Pw[tv]
    tid, bary = UC.raster_ids(U, size)
    ys, xs = np.nonzero(tid >= 0)
    ti = tid[ys, xs]
    b1, b2 = bary[ys, xs, 0], bary[ys, xs, 1]
    b0 = 1 - b1 - b2
    tri = P3[ti]
    pts = tri[:, 0] * b0[:, None] + tri[:, 1] * b1[:, None] + tri[:, 2] * b2[:, None]
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    # winding: make the face normals point outward by the mesh's own polygon normals
    pn = np.empty(len(me.polygons) * 3)
    me.polygons.foreach_get("normal", pn)
    pn = pn.reshape(-1, 3) @ mw[:3, :3].T
    lt_poly = np.array([t.polygon_index for t in me.loop_triangles])
    nrm = np.where(((nrm * pn[lt_poly[ti]]).sum(1) < 0)[:, None], -nrm, nrm)
    nisl = len(pts)
    bvh = BVHTree.FromPolygons([Vector(p) for p in Pw], [tuple(t.vertices) for t in me.loop_triangles])
    palm_default = np.array([0.0, 0.0, -1.0])
    acc_c = np.zeros((nisl, 3))
    acc_w = np.zeros(nisl)
    reasons = np.zeros(nisl, int)
    info, files = [], []
    outd = L.ARGS["out_dir"]
    os.makedirs(outd, exist_ok=True)
    for pi, ph in enumerate(photos):
        if L.is_id(ph["image"]) or isinstance(ph["image"], dict):
            img = UC.load_image(L.resolve(ph["image"], what=f"photos[{pi}].image"))
        else:
            ip = str(ph["image"])
            if ip.startswith("out:"):
                ip = os.path.join(outd, ip[4:])
            img = UC.load_image(ip)
        H_, W_ = img.shape[:2]
        skinm = None
        if L.param("skin_mask", True):
            r_, g_, b_ = img[..., 0] * 255, img[..., 1] * 255, img[..., 2] * 255
            yy_ = 0.299 * r_ + 0.587 * g_ + 0.114 * b_
            cb_ = 128 - 0.168736 * r_ - 0.331264 * g_ + 0.5 * b_
            cr_ = 128 + 0.5 * r_ - 0.418688 * g_ - 0.081312 * b_
            mx_, mn_ = np.maximum(np.maximum(r_, g_), b_), np.minimum(np.minimum(r_, g_), b_)
            hard = (cb_ >= 77) & (cb_ <= 127) & (cr_ >= 135) & (cr_ <= 173) & (yy_ > 50) & ((mx_ - mn_) > 0.12 * np.maximum(mx_, 1))
            # shadow: much darker than the skin around it (the contact shadow and the grazing edge of a finger), judged against a large blur of the skin pixels' own luminance
            sk0 = ((cb_ >= 77) & (cb_ <= 127) & (cr_ >= 135) & (cr_ <= 173)).astype(np.float32)
            local = blur(yy_ * sk0, 60) / np.maximum(blur(sk0, 60), 1e-4)
            hard = hard & (yy_ > 0.72 * local)
            ero = int(L.param("edge_erode_px", 20))
            skinm = blur(hard.astype(np.float32), 3)
            skinm = np.clip((skinm - 0.5) * 2.0, 0, 1)
            if ero > 0:  # keep only texels well inside the skin region: the photo's contact shadow and grazing edge of the hand do not paint
                skinm = skinm * (blur(hard.astype(np.float32), ero) > 0.98)
        vf = np.array(ph.get("view_from", -palm_default), float)
        vf /= np.linalg.norm(vf)
        # ---- landmarks: 3D points on the surface and their pixels
        X, Q, names = [], [], []
        for p in ph.get("points", []):
            if "vertex" in p:
                x = Pw[int(p["vertex"])]
            elif "mm" in p:
                x = np.array(p["mm"], float) / 1000
            elif "joint" in p:
                if arm is None:
                    raise RuntimeError("a 'joint' point needs the rig (armature)")
                bn = arm.data.bones[p["joint"] if p["joint"] in arm.data.bones else "mixamorig:" + p["joint"]]
                at_tail = p.get("at", "head") == "tail"
                j = np.array(arm.matrix_world @ (bn.tail_local if at_tail else bn.head_local))
                if p.get("back_mm"):  # move this many mm along the bone toward its other end (a nail centre: the last bone's tail moved 4-6 mm back toward its head)
                    other = np.array(arm.matrix_world @ (bn.head_local if at_tail else bn.tail_local))
                    dvec = other - j
                    j = j + dvec / max(np.linalg.norm(dvec), 1e-9) * float(p["back_mm"]) / 1000
                # the first surface hit from the joint toward the camera
                hit = bvh.ray_cast(Vector(j.tolist()), Vector(vf.tolist()), 0.2)
                x = np.array(hit[0]) if hit[0] is not None else j
            else:
                raise RuntimeError(f"point {p.get('name')}: give vertex, mm or joint")
            X.append(x)
            Q.append(p["px"])
            names.append(p.get("name", f"p{len(names)}"))
        X, Q = np.array(X), np.array(Q, float)
        if len(X) < 4:
            raise RuntimeError("at least 4 landmark pairs per photo")
        # ---- affine camera
        Xh = np.hstack([X, np.ones((len(X), 1))])
        # least squares with a small ridge on the linear part (planar sets are degenerate along the viewing direction)
        lam = 1e-9
        Am = np.linalg.solve(Xh.T @ Xh + lam * np.eye(4), Xh.T @ Q).T  # (2, 4)
        proj0 = Xh @ Am.T
        res0 = np.linalg.norm(proj0 - Q, axis=1)
        view = np.cross(Am[0, :3], Am[1, :3])
        view /= np.linalg.norm(view) + 1e-12
        if view @ vf < 0:
            view = -view
        warp = None
        if do_warp and len(X) >= 4:
            warp = tps_fit(proj0, Q)
            res1 = np.linalg.norm(warp(proj0) - Q, axis=1)
        else:
            res1 = res0
        # ---- project the texels
        ph_h = np.hstack([pts, np.ones((nisl, 1))]) @ Am.T
        uv_px = warp(ph_h) if warp is not None else ph_h
        u, v = uv_px[:, 0], uv_px[:, 1]
        inside = (u >= 0) & (u < W_) & (v >= 0) & (v < H_)
        cosv = nrm @ view
        facing = cosv >= min_cos
        cand = inside & facing
        dd = np.full(nisl, np.inf)
        idx = np.where(cand)[0]
        org = view * 0.5
        for i in idx:
            o = Vector((pts[i] + org).tolist())
            hit = bvh.ray_cast(o, Vector((-view).tolist()), 0.5 + 0.003)
            if hit[0] is not None:
                dd[i] = (np.array(hit[0]) - pts[i]).dot(view)
        vis = cand & np.isfinite(dd) & (np.abs(dd) < 0.003)
        fall = np.clip(np.minimum.reduce([u, W_ - u, v, H_ - v]) / 40.0, 0, 1)
        ramp = np.clip((cosv - min_cos) / max(fade_cos, 1e-6), 0, 1)
        w = np.where(vis, ramp * ramp * (3 - 2 * ramp) * fall * float(ph.get("weight", 1.0)), 0.0)
        if skinm is not None:
            w = w * sample(skinm[..., None], u, v)[:, 0]
        got = w > 1e-4
        if got.any():
            col = sample(img, u[got], v[got])[:, :3]
            acc_c[got] += col * w[got, None]
            acc_w[got] += w[got]
        away = inside & ~facing
        hidden = cand & ~vis
        reasons = np.where(got, 0, np.where(hidden, 1, np.where(away, 2, np.where(~inside, 3, reasons))))
        # reproject picture
        chk = img[..., :3].copy()
        pu = (np.hstack([Pw, np.ones((nv, 1))]) @ Am.T)
        pu = warp(pu) if warp is not None else pu
        okv = (pu[:, 0] >= 1) & (pu[:, 0] < W_ - 2) & (pu[:, 1] >= 1) & (pu[:, 1] < H_ - 2)
        for dx in (0, 1):
            for dy in (0, 1):
                chk[pu[okv, 1].astype(int) + dy, pu[okv, 0].astype(int) + dx] = (1, 0, 0)
        for q in Q:
            r_ = 4
            y0, x0 = int(q[1]), int(q[0])
            chk[max(y0 - r_, 0):y0 + r_ + 1, max(x0 - 1, 0):x0 + 2] = (0, 1, 0)
            chk[max(y0 - 1, 0):y0 + 2, max(x0 - r_, 0):x0 + r_ + 1] = (0, 1, 0)
        p = os.path.join(outd, f"reproject-{pi}.png")
        UC.save_image(chk, p, "sRGB")
        files.append(p)
        info.append({"photo": pi, "image_size": [W_, H_], "view_direction": [round(float(x), 4) for x in view], "camera_A": [[round(float(x), 6) for x in r] for r in Am],
                     "landmarks": [{"name": n_, "px": [float(q[0]), float(q[1])], "residual_before_warp_px": round(float(a), 2), "residual_after_px": round(float(b), 2)} for n_, q, a, b in zip(names, Q, res0, res1)],
                     "warp": bool(warp is not None), "texels_painted_pct": round(float(got.mean() * 100), 1), "hidden_pct": round(float(hidden.mean() * 100), 1), "facing_away_pct": round(float(away.mean() * 100), 1),
                     "outside_photo_pct": round(float((~inside).mean() * 100), 1)})
    have = acc_w > 1e-9
    colour = np.zeros((size, size, 3), np.float32)
    valid = np.zeros((size, size), bool)
    colour[ys[have], xs[have]] = (acc_c[have] / acc_w[have, None]).astype(np.float32)
    valid[ys[have], xs[have]] = True
    # the painted area's own rim (the photo's shaded edge of a finger, a half-covered texel) is dropped: only the interior of the painted area counts as photo
    er = int(L.param("rim_erode_texels", 8))
    if er > 0 and valid.any():
        core = blur(valid.astype(np.float32), max(er // 2, 1)) > 0.97
        valid = valid & core
    island = np.zeros((size, size), bool)
    island[ys, xs] = True
    mean_col = colour[valid].mean(0) if valid.any() else np.array([0.55, 0.40, 0.32])
    notes = []
    if L.param("fill", "mean") in ("mean", "global"):
        # unreached texels: the average colour of the texels around them (a blurred version of what we have); the painted area gives way to it SOFTLY (feather), no hard outline
        rr_ = max(size // 16, 4)
        wsum = blur(valid.astype(np.float32), rr_)
        csum = blur(colour * valid[..., None], rr_)
        near = csum / np.maximum(wsum[..., None], 1e-4)
        fill = np.where((wsum > 1e-3)[..., None], near, mean_col[None, None, :])
        if L.param("fill") == "global":
            fill = np.broadcast_to(mean_col[None, None, :], fill.shape)
        wfull = max(float(np.percentile(acc_w[have], 60)) if have.any() else 1.0, 1e-6)
        conf = np.zeros((size, size), np.float32)
        conf[ys, xs] = np.clip(acc_w / wfull, 0, 1)
        fe = int(L.param("feather_px", 48))
        conf = np.clip(blur(conf, max(fe // 2, 1)) * 1.0, 0, 1) if fe > 0 else conf
        conf = np.where(valid, np.maximum(conf, 0.0), conf)
        colour = colour * conf[..., None] + fill * (1 - conf[..., None])
    else:
        colour[island & ~valid] = (1, 0, 1)
    if pad_px > 0:
        colour, _ = UC.dilate_fill(colour, island, pad_px)
    p = os.path.join(outd, f"{name}-colour.png")
    UC.save_image(colour[::-1], p, "sRGB")
    files.append(p)
    cov = np.zeros((size, size, 3), np.float32)
    cov[ys, xs] = np.clip(acc_w / max(np.percentile(acc_w[have], 95) if have.any() else 1, 1e-9), 0, 1)[:, None]
    p = os.path.join(outd, f"{name}-coverage.png")
    UC.save_image(cov[::-1], p, "sRGB")
    files.append(p)
    fail = np.full((size, size, 3), 0.15, np.float32)
    for k, cv in {0: (0.1, 0.8, 0.2), 1: (1, 0.1, 0.1), 2: (1, 0.55, 0.0), 3: (1, 0.9, 0.1)}.items():
        sel = (reasons == k) & ((~have) if k else have)
        fail[ys[sel], xs[sel]] = cv
    p = os.path.join(outd, f"{name}-failure.png")
    UC.save_image(fail[::-1], p, "sRGB")
    files.append(p)
    luma = colour @ np.array([0.299, 0.587, 0.114], np.float32)
    detail = blur(luma - blur(luma, hp_px), 1)
    rg = L.param("roughness", [0.55, 0.15])
    if rg:
        centre, amt = (rg + [0.15])[:2] if isinstance(rg, list) else (0.55, 0.15)
        r_ = np.clip(centre - detail * amt * 4, 0.05, 1.0)
        rimg = np.repeat(r_[..., None], 3, axis=2)
        p = os.path.join(outd, f"{name}-roughness.png")
        UC.save_image(rimg[::-1], p, "Non-Color")
        files.append(p)
    ns = float(L.param("normal", 0.12))
    if ns > 0:
        gy, gx = np.gradient(detail)
        sc = ns * 40.0
        nx, ny, nz = -gx * sc, gy * sc, np.ones_like(gx)  # OpenGL: +Y up in the sheet (rows are top-down here)
        ln = np.sqrt(nx * nx + ny * ny + nz * nz)
        nmap = np.stack([nx / ln * 0.5 + 0.5, ny / ln * 0.5 + 0.5, nz / ln * 0.5 + 0.5], axis=2).astype(np.float32)
        nmap[~island] = (0.5, 0.5, 1.0)
        p = os.path.join(outd, f"{name}-normal.png")
        UC.save_image(nmap[::-1], p, "Non-Color")
        files.append(p)
        notes.append("the normal picture is a weak relief from the photo's luminance high-pass, NOT measured: inspect with the normal map on and off")
    notes.append("the photo and the registration are not saved into the scene: feed the pictures to material_assign")
    L.finish({"photos": info, "size": size, "uv": uvn, "mesh": mesh.name, "island_texels": int(nisl), "painted_pct": round(float(have.mean() * 100), 1), "mean_colour_srgb": [round(float(x), 3) for x in mean_col],
              "files": [os.path.basename(f) for f in files], "notes": notes}, files=files, save=False)


L.run(main)
