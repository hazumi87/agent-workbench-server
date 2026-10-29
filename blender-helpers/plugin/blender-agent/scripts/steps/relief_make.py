"""relief_make — turn ONE view of a `view_capture` (colour + depth + mask + normal + camera json) into a lightweight RELIEF MESH in the scene: a coarse grid of the visible surface, displaced to the captured depth, textured with the captured colour, with the captured world normals as vertex normals. It exports as an ordinary GLB (mesh + one packed colour texture), shows real parallax, and needs no custom shader. Saves a checkpoint (not with dry_run).

How: every `step_px`-th pixel of the picture is a sample; a sample is kept when the mask says a surface was hit (and, with `world_box`, when its world point is inside the box). Its position is the camera's own ray at the captured z-depth (the contract in `view_capture`). Two triangles are made for each 2 x 2 block of kept samples, UV = the sample's place in the colour picture. A block is NOT made (a HOLE) when an edge of it is nearly parallel to the view ray (a depth jump: the step in depth is more than tan(`max_slope_deg`) times the sideways step) so a silhouette is not stretched into a rubber sheet. If the triangle count would pass `max_tris`, `step_px` is raised until it fits.
params:
  capture      path of the <prefix>.capture.json written by view_capture (the pictures are read from beside it; absolute, or inside this job's out folder)   [required]
  view         the camera name in that json   [required]
  name         object name (default "Relief_<view>"); running again with the same name replaces it
  step_px      sample spacing in pixels (default 8)
  max_tris     triangle budget (default 60000)
  max_slope_deg  default 80: edges steeper than this against the view ray are broken (holes), 60..89
  world_box    {"min": [x, y, z], "max": [x, y, z]} (a null for a side leaves it open): only samples inside are kept, e.g. {"max": [null, -2.0, null]} keeps world y <= -2.0 m (an interior behind a facade)
  fill_px      LAYERED FILL (default 0 = off; try 24): behind every foreground edge (a depth jump) the far surface is continued under the foreground by this many pixels, as a second mesh `<name>_fill` with its own picture, so no hole opens to the background when the view moves; silhouettes stay at the grid step. The fill's colour is inpainted from the far side
  fill_unseen_px  also close pixels the capture never hit (mask 0) up to this many pixels from a hit surface (default 0 = off): a closed backing, not real geometry, painted `unseen_colour` (default a dark [0.04, 0.04, 0.04], sRGB 0..1) and marked as inferred; stays inside `world_box`
  unseen_colour   [r, g, b] 0..1 for that backing
  dry_run      true: measure only (the counts and holes), no mesh
Returns: vertices, triangles, step_px used, size of the colour picture, kept / hole counts (background, outside the box, depth jump), the share of the hit pixels the mesh covers, the largest depth gap between neighbours in kept triangles, bounds (metres), the material and picture names, notes. The mesh stays in WORLD coordinates (the camera's frame), no parent; its normals are the captured world normals at the vertices (not a normal texture).
With fill_px the delivered pieces are `<name>` (the surface seen) and `<name>_fill` (what is behind the foreground edges); each has one packed picture. Limits: one view cannot show what it did not see, so an oblique look reveals HOLES behind foreground objects and a flat 'shadow' of each object on what is behind it; thin features smaller than the step are lost; the colour is the captured diffuse colour (no lights); normals are per vertex, not per pixel.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402
import _lib as L  # noqa: E402


def pixels(path, raw=True):
    im = bpy.data.images.load(path, check_existing=False)
    if raw:
        im.colorspace_settings.name = "Non-Color"
    w, h = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, im.channels)[::-1]  # Blender stores rows bottom-up: row 0 here is the TOP
    bpy.data.images.remove(im)
    return a, w, h, None


def main():
    cap = L.param("capture")
    view = L.param("view")
    if not cap or not view:
        raise RuntimeError('give capture: "<path of the .capture.json>" and view: "<camera name>"')
    cap = cap if os.path.isabs(cap) else os.path.join(L.ARGS["out_dir"], cap)
    if not os.path.exists(cap):
        raise RuntimeError(f"no such capture json: {cap}")
    meta = json.load(open(cap))
    cam = next((c for c in meta["cameras"] if c["name"] == view), None)
    if cam is None:
        raise RuntimeError(f"no view {view!r} in the capture (views: {[c['name'] for c in meta['cameras']]})")
    base = os.path.dirname(cap)
    f = cam["files"]
    W, H = cam["res"]
    fx = cam["intrinsics_px"]["fx"]
    cx, cy = cam["intrinsics_px"]["cx"], cam["intrinsics_px"]["cy"]
    near, far = meta["depth"]["near"], meta["depth"]["far"]
    nm = L.param("name") or f"Relief_{view}"
    step = max(1, int(L.param("step_px", 8)))
    max_tris = int(L.param("max_tris", 60000))
    slope = float(L.param("max_slope_deg", 80))
    if not 60 <= slope <= 89:
        raise RuntimeError("max_slope_deg must be 60..89")
    tan_s = math.tan(math.radians(slope))
    box = L.param("world_box") or {}
    dry = bool(L.param("dry_run", False))
    fill_px = max(0, int(L.param("fill_px", 0)))
    unseen_px = max(0, int(L.param("fill_unseen_px", 0)))
    unseen_col = [float(x) for x in (L.param("unseen_colour") or [0.04, 0.04, 0.04])]
    dep, dw, dh, _ = pixels(os.path.join(base, f["depth16"]))
    msk, mw, mh, _ = pixels(os.path.join(base, f["mask"]))
    nor, nw, nh, _ = pixels(os.path.join(base, f["normal"]))
    if not (dw, dh) == (mw, mh) == (nw, nh) == (W, H):
        raise RuntimeError(f"picture sizes differ from the camera's res {W}x{H}")
    Z = near + dep[..., 0].astype(np.float64) * (far - near)
    hit = msk[..., 0] > 0.5
    M = np.array(cam["matrix_world"], dtype=np.float64)

    def build(st):
        us = np.arange(st // 2, W, st)
        vs = np.arange(st // 2, H, st)
        U, V = np.meshgrid(us, vs)
        z = Z[V, U]
        ok = hit[V, U]
        xn, yn = (U + 0.5 - cx) / fx, -(V + 0.5 - cy) / fx
        p_cam = np.stack([xn * z, yn * z, -z, np.ones_like(z)], axis=-1)
        p = p_cam @ M.T
        P = p[..., :3]
        inbox = np.ones_like(ok)
        for ax, key in enumerate(("min", "max")):
            for i, v_ in enumerate(box.get(key) or [None, None, None]):
                if v_ is not None:
                    inbox &= (P[..., i] >= v_) if key == "min" else (P[..., i] <= v_)
        keep = ok & inbox
        gh, gw = U.shape
        side = st * z / fx  # sideways metres between neighbouring samples

        def jump(za, zb, sa, sb):
            return np.abs(za - zb) > tan_s * np.maximum(0.5 * (sa + sb), 1e-6)

        tris, counts = [], {"background": 0, "outside_box": 0, "depth_jump": 0}
        a = np.arange(gh * gw).reshape(gh, gw)
        for i in range(gh - 1):
            for j in range(gw - 1):
                q = [(i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)]
                if not all(ok[r, c] for r, c in q):
                    counts["background"] += 1
                    continue
                if not all(keep[r, c] for r, c in q):
                    counts["outside_box"] += 1
                    continue
                zs = [z[r, c] for r, c in q]
                ss = [side[r, c] for r, c in q]
                if any(jump(zs[k], zs[(k + 1) % 4], ss[k], ss[(k + 1) % 4]) for k in range(4)):
                    counts["depth_jump"] += 1
                    continue
                if abs(zs[0] - zs[2]) <= abs(zs[1] - zs[3]):  # cut along the diagonal with the smaller depth step
                    tris += [(a[q[0]], a[q[1]], a[q[2]]), (a[q[0]], a[q[2]], a[q[3]])]
                else:
                    tris += [(a[q[0]], a[q[1]], a[q[3]]), (a[q[1]], a[q[2]], a[q[3]])]
        return U, V, z, P, keep, tris, counts, gh, gw, ok, side, inbox


    DIRS8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

    def sh(a, di, dj, fv):
        h, w = a.shape[:2]
        pad = [(1, 1), (1, 1)] + [(0, 0)] * (a.ndim - 2)
        ap = np.pad(a, pad, constant_values=fv)
        return ap[1 + di:1 + di + h, 1 + dj:1 + dj + w]

    def dilate(m):
        out = m.copy()
        for di, dj in DIRS8:
            out |= sh(m, di, dj, False)
        return out

    def layered(st, U, V, z, ok, keep, side, inbox_fn):
        """the far surface continued behind foreground edges (and over unseen pixels): returns the sample grids of the fill depth, the source sample of each filled sample, the filled masks and the extension triangles"""
        gh, gw = z.shape
        idx = np.arange(gh * gw).reshape(gh, gw)
        near_seed = np.zeros((gh, gw), bool)
        far_seed = np.zeros((gh, gw), bool)
        for da, db in ((0, 1), (1, 0)):
            za, zb = z[:gh - da, :gw - db], z[da:, db:]
            oka = keep[:gh - da, :gw - db] & keep[da:, db:]
            sa, sb = side[:gh - da, :gw - db], side[da:, db:]
            jmp = oka & (np.abs(za - zb) > tan_s * np.maximum(0.5 * (sa + sb), 1e-6))
            an, bn = jmp & (za < zb), jmp & (zb < za)
            near_seed[:gh - da, :gw - db] |= an
            far_seed[da:, db:] |= an
            near_seed[da:, db:] |= bn
            far_seed[:gh - da, :gw - db] |= bn
        far_seed &= ~near_seed
        nb = max(1, int(math.ceil(fill_px / st))) if fill_px else 0
        band = near_seed.copy()
        for _ in range(nb):
            band = dilate(band) & keep
        zf = np.where(far_seed, z, np.nan)
        src = np.where(far_seed, idx, -1)
        filled_band = np.zeros((gh, gw), bool)

        def grow(cand, zf, src, iters):
            for _ in range(iters):
                best = np.full(z.shape, -np.inf)
                bsrc = np.full(z.shape, -1)
                for di, dj in DIRS8:
                    nz, ns = sh(zf, di, dj, np.nan), sh(src, di, dj, -1)
                    better = ~np.isnan(nz) & (nz > best)
                    best = np.where(better, nz, best)
                    bsrc = np.where(better, ns, bsrc)
                newly = cand & np.isnan(zf) & (bsrc >= 0)
                if not newly.any():
                    break
                zf = np.where(newly, best, zf)
                src = np.where(newly, bsrc, src)
            return zf, src

        if nb:
            zf, src = grow(band & ~far_seed, zf, src, nb + 1)
            filled_band = ~np.isnan(zf) & ~far_seed
        filled_unseen = np.zeros((gh, gw), bool)
        if unseen_px:
            un = int(math.ceil(unseen_px / st))
            zf2 = np.where(~np.isnan(zf), zf, np.where(ok, z, np.nan))
            src2 = np.where(src >= 0, src, np.where(ok, idx, -1))
            cand = ~ok
            reach = ok.copy()
            for _ in range(un):
                reach = dilate(reach)
            zf2, src2 = grow(cand & reach, zf2, src2, un + 1)
            filled_unseen = ~ok & ~np.isnan(zf2)
            zf = np.where(filled_unseen, zf2, zf)
            src = np.where(filled_unseen, src2, src)
        new = filled_band | filled_unseen
        zx = np.where(np.isnan(zf) & ok & keep, z, zf)  # the seen samples join at their own depth, so no strip is left between the fill and the main mesh
        ext = ~np.isnan(zx)
        zf_all = zx
        # positions of the fill samples
        zz = np.where(ext, zx, 1.0)
        xn, yn = (U + 0.5 - cx) / fx, -(V + 0.5 - cy) / fx
        Pf = (np.stack([xn * zz, yn * zz, -zz, np.ones_like(zz)], axis=-1) @ M.T)[..., :3]
        ib = inbox_fn(Pf)
        tris_e = []
        for i in range(gh - 1):
            for j in range(gw - 1):
                q = [(i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)]
                if not all(ext[r, c] and ib[r, c] for r, c in q) or not any(new[r, c] for r, c in q):
                    continue
                zs = [zx[r, c] for r, c in q]
                ss = [st * zx[r, c] / fx for r, c in q]
                if any(abs(zs[k] - zs[(k + 1) % 4]) > tan_s * max(0.5 * (ss[k] + ss[(k + 1) % 4]), 1e-6) for k in range(4)):
                    continue
                tris_e += [(idx[q[0]], idx[q[1]], idx[q[2]]), (idx[q[0]], idx[q[2]], idx[q[3]])]
        return {"zf": zf, "zx": zx, "src": np.where(src >= 0, src, idx), "new": new, "band": filled_band, "unseen": filled_unseen, "tris": tris_e, "P": Pf, "near_seed": near_seed, "far_seed": far_seed, "idx": idx}

    def inpaint_colour(colour, st, fill):
        """the colour picture with the fill regions replaced by colour taken from the far side (a neighbour counts only if its depth is not nearer than the fill's depth, so foreground colour is not smeared into the background)"""
        h, w = Z.shape
        new = fill["new"]
        gh, gw = new.shape
        reg = np.kron(new.astype(np.uint8), np.ones((st, st), np.uint8)).astype(bool)
        pad = np.zeros((h, w), bool)
        hh, ww = min(h, reg.shape[0]), min(w, reg.shape[1])
        pad[:hh, :ww] = reg[:hh, :ww]
        zfp = np.kron(np.where(np.isnan(fill["zf"]), 0.0, fill["zf"]), np.ones((st, st)))
        zfx = np.zeros((h, w))
        zfx[:hh, :ww] = zfp[:hh, :ww]
        out = colour[..., :3].copy()
        known = hit & ~pad
        tol = 0.05
        for _ in range(fill_px + unseen_px + 2 * st + 2):
            acc = np.zeros_like(out)
            cnt = np.zeros((h, w))
            for di, dj in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                kn = sh(known, di, dj, False)
                zn = sh(Z, di, dj, 0.0)
                okn = kn & ((zn >= zfx * (1 - tol)) | (zfx == 0))
                acc += np.where(okn[..., None], sh(out, di, dj, 0.0), 0.0)
                cnt += okn
            newly = pad & ~known & (cnt > 0)
            if not newly.any():
                break
            out = np.where(newly[..., None], acc / np.maximum(cnt, 1)[..., None], out)
            known = known | newly
        rest = pad & ~known  # nothing reachable: a mid grey rather than the foreground
        out = np.where(rest[..., None], 0.18, out)
        ureg = np.kron(fill["unseen"].astype(np.uint8), np.ones((st, st), np.uint8)).astype(bool)
        un = np.zeros((h, w), bool)
        un[:hh, :ww] = ureg[:hh, :ww]
        out = np.where(un[..., None], np.array(unseen_col, dtype=out.dtype)[None, None, :], out)
        inferred = np.where(un, 0.5, np.where(pad, 1.0, 0.0)).astype(np.float32)
        return out, int(pad.sum()), int((rest & ~un).sum()), inferred, int(un.sum())

    def inbox_fn(P_):
        ib = np.ones(P_.shape[:2], bool)
        for key in ("min", "max"):
            for i, v_ in enumerate(box.get(key) or [None, None, None]):
                if v_ is not None:
                    ib &= (P_[..., i] >= v_) if key == "min" else (P_[..., i] <= v_)
        return ib

    st = step
    while True:
        U, V, z, P, keep, tris, counts, gh, gw, ok, side, inbox = build(st)
        if len(tris) <= max_tris:
            break
        st += 1 if st < 4 else max(1, st // 8)
        if st > min(W, H) // 4:
            raise RuntimeError(f"cannot fit {max_tris} triangles: even step_px {st} gives {len(tris)}")
    used = np.unique(np.array(tris).ravel()) if tris else np.array([], dtype=int)
    covered = float(len(tris)) * st * st / 2.0
    hit_px = int(hit.sum())
    gaps = []
    zf = z.ravel()
    for t in tris:
        zz = zf[list(t)]
        gaps.append(float(zz.max() - zz.min()))
    rep = {"vertices": int(len(used)), "triangles": len(tris), "step_px_used": st, "step_px_requested": step, "picture": [W, H], "quads_not_made": counts,
           "hit_pixels_covered_share": round(min(1.0, covered / max(hit_px, 1)), 3), "largest_depth_gap_in_kept_triangle_m": round(max(gaps), 4) if gaps else None,
           "max_slope_deg": slope, "world_box": box or None}
    if not tris:
        raise RuntimeError(f"no triangles would be made: {counts}")
    fill = None
    if fill_px or unseen_px:
        fill = layered(st, U, V, z, ok, keep, side, inbox_fn)
        rep["fill"] = {"fill_px": fill_px, "fill_unseen_px": unseen_px, "band_samples": int(fill["band"].sum()), "unseen_samples": int(fill["unseen"].sum()), "triangles": len(fill["tris"]),
                       "vertices": int(len(np.unique(np.array(fill["tris"]).ravel()))) if fill["tris"] else 0}
    if not dry:
        old = bpy.data.objects.get(nm)
        if old is not None:
            if "relief_source" not in old:
                raise RuntimeError(f"{nm}: an object of that name exists and was not made by relief_make: it is never replaced")
            bpy.data.objects.remove(old, do_unlink=True)
        remap = -np.ones(gh * gw, dtype=int)
        remap[used] = np.arange(len(used))
        Pf = P.reshape(-1, 3)
        verts = [tuple(float(x) for x in Pf[i]) for i in used]
        faces = [tuple(int(remap[i]) for i in t) for t in tris]
        me = bpy.data.meshes.new(nm)
        me.from_pydata(verts, [], faces)
        uvl = me.uv_layers.new(name="UVMap")
        Uf, Vf = U.ravel(), V.ravel()
        uvs = {int(remap[i]): ((Uf[i] + 0.5) / W, 1.0 - (Vf[i] + 0.5) / H) for i in used}
        for lp in me.loops:
            uvl.data[lp.index].uv = uvs[lp.vertex_index]
        nvec = nor[V, U][..., :3].reshape(-1, 3) * 2.0 - 1.0
        nvec = nvec / np.maximum(np.linalg.norm(nvec, axis=1, keepdims=True), 1e-6)
        me.normals_split_custom_set_from_vertices([tuple(float(x) for x in nvec[i]) for i in used])
        me.update()
        ob = bpy.data.objects.new(nm, me)
        ob["relief_source"] = json.dumps({"capture": os.path.basename(cap), "view": view, "step_px": st})
        bpy.context.scene.collection.objects.link(ob)
        img = bpy.data.images.load(os.path.join(base, f["colour"]), check_existing=False)
        img.colorspace_settings.name = "sRGB"
        img.name = f"{nm}-colour"
        img.pack()
        mat = bpy.data.materials.new(f"{nm}-mat")
        mat.use_nodes = True
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = img
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.9
        bsdf.inputs["Metallic"].default_value = 0.0
        me.materials.append(mat)
        mn, mx = np.min(Pf[used], axis=0), np.max(Pf[used], axis=0)
        rep["bounds_m"] = [[round(float(x), 4) for x in mn], [round(float(x), 4) for x in mx]]
        rep["object"], rep["material"], rep["picture_packed"] = nm, mat.name, img.name
        if fill is not None and fill["tris"]:
            oldf = bpy.data.objects.get(nm + "_fill")
            if oldf is not None:
                if "relief_source" not in oldf:
                    raise RuntimeError(f"{nm}_fill: an object of that name exists and was not made by relief_make: it is never replaced")
                bpy.data.objects.remove(oldf, do_unlink=True)
            col, _, _, _ = pixels(os.path.join(base, f["colour"]))
            out_c, n_reg, n_rest, inferred, n_un = inpaint_colour(col, st, fill)
            mimg = bpy.data.images.new(f"{nm}_fill-inferred", W, H, alpha=False)
            mimg.colorspace_settings.name = "Non-Color"
            mimg.pixels.foreach_set(np.concatenate([np.repeat(inferred[::-1, :, None], 3, axis=2), np.ones((H, W, 1), np.float32)], axis=-1).ravel())
            mimg.file_format = "PNG"
            mimg.filepath_raw = os.path.join(L.ARGS["out_dir"], f"{nm}_fill-inferred.png")
            os.makedirs(L.ARGS["out_dir"], exist_ok=True)
            mimg.save()
            bpy.data.images.remove(mimg)
            img2 = bpy.data.images.new(f"{nm}_fill-colour", W, H, alpha=True)
            img2.colorspace_settings.name = "Non-Color"
            rgba = np.concatenate([out_c.astype(np.float32), np.ones((H, W, 1), np.float32)], axis=-1)[::-1]
            img2.pixels.foreach_set(rgba.ravel())
            img2.file_format = "PNG"
            img2.pack()
            img2.colorspace_settings.name = "sRGB"
            ft = np.array(fill["tris"])
            fused = np.unique(ft.ravel())
            fmap = -np.ones(gh * gw, dtype=int)
            fmap[fused] = np.arange(len(fused))
            PF = fill["P"].reshape(-1, 3)
            fverts = [tuple(float(x) for x in PF[i]) for i in fused]
            ffaces = [tuple(int(fmap[i]) for i in t) for t in ft]
            mf = bpy.data.meshes.new(nm + "_fill")
            mf.from_pydata(fverts, [], ffaces)
            uvf = mf.uv_layers.new(name="UVMap")
            fuv = {int(fmap[i]): ((Uf[i] + 0.5) / W, 1.0 - (Vf[i] + 0.5) / H) for i in fused}
            for lp in mf.loops:
                uvf.data[lp.index].uv = fuv[lp.vertex_index]
            srcs = fill["src"].ravel()
            NR = nor[V, U][..., :3].reshape(-1, 3) * 2.0 - 1.0
            NR = NR / np.maximum(np.linalg.norm(NR, axis=1, keepdims=True), 1e-6)
            mf.normals_split_custom_set_from_vertices([tuple(float(x) for x in NR[srcs[i]]) for i in fused])
            mf.update()
            of = bpy.data.objects.new(nm + "_fill", mf)
            of["relief_source"] = json.dumps({"capture": os.path.basename(cap), "view": view, "step_px": st, "fill": True})
            bpy.context.scene.collection.objects.link(of)
            matf = bpy.data.materials.new(f"{nm}_fill-mat")
            matf.use_nodes = True
            bf = next(n for n in matf.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
            tf = matf.node_tree.nodes.new("ShaderNodeTexImage")
            tf.image = img2
            matf.node_tree.links.new(tf.outputs["Color"], bf.inputs["Base Color"])
            bf.inputs["Roughness"].default_value = 0.9
            bf.inputs["Metallic"].default_value = 0.0
            mf.materials.append(matf)
            rep["fill"].update({"object": nm + "_fill", "material": matf.name, "picture_packed": img2.name, "inferred_pixels_in_fill_region": n_reg, "of_which_dark_backing_over_unseen": n_un, "pixels_with_no_far_colour_(mid_grey)": n_rest, "inferred_mask_file": f"{nm}_fill-inferred.png (white = inpainted from the far side, grey = dark backing over unseen pixels, black = captured pixels)", "unseen_colour": unseen_col})
    rep["dry_run"] = dry
    rep["notes"] = ["the mesh is in WORLD coordinates (the capture camera's frame), no parent", "normals are the captured world normals at the vertices, not a normal texture", "holes (quads not made) are where the view saw background, left the world_box, or met a depth jump: an oblique look shows what this one view could not see"]
    L.finish(rep, save=not dry)


L.run(main)
