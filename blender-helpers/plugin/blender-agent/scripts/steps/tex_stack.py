"""tex_stack — edit a texture as a stack of reversible versions: layers and picture patches through masks, fills, padding, revert and compare, export with colour-space control. Saves no checkpoint.

Every op that changes the picture writes a NEW version file (work/<job>/tex/<stack>/v<N>.png) and a manifest.json that lists them all with the op that made each, so any version can be brought back (`revert`, `undo`) and nothing
is ever overwritten. The scene is not touched: this is about image files. Images are read and written as stored (an 8-bit file is sRGB-encoded); `colour_space` says what the stack holds (sRGB for colour, Non-Color for
roughness / metallic / normal) and `export` can convert. File names: a path under the tool root, an absolute path, or "out:<name>" for a file in this job's out/ folder. The pictures are as they are opened (row 0 = top);
a UV sheet from photo_project / uv_rebake is stored the same way, so masks from them line up.

params:
  stack   the stack's name (required): its versions live in work/<job>/tex/<stack>/
  ops     a list, run in order, each {op, ...}:
    {"op": "init", "image": "out:v3d-proj-base_color.png", "colour_space": "sRGB", "size": 1024}        start the stack (version 0) from a picture, scaled to `size` if given
    {"op": "layer", "file": "out:proj-colour.png", "mask": "out:proj-mask-0.png" | "alpha", "mode": "normal", "strength": 1.0, "feather_px": 4, "invert_mask": false}
                    composite a picture over the current one through a mask (white = apply; none = everywhere); modes normal, multiply, screen, lighten, darken, colour (keeps the picture's colour, the current lightness)
    {"op": "fill", "colour": [r, g, b], "mask": "out:m.png", "strength": 1.0}                             flat colour through a mask
    {"op": "fill_missing", "marker": [1, 0, 1], "tolerance": 0.02, "padding_px": 32, "colour": null, "mask": null, "mask_threshold": 0.5, "grow_px": 0}
                                                                                                          texels that still hold the marker colour (magenta from photo_project / uv_rebake): filled from the nearest valid texels, up to `padding_px`, or with `colour`.
                                                                                                          `mask` (a picture, white = missing, e.g. out:<name>-misses.png) adds those texels, so antialiased marker pixels the tolerance misses are caught; `grow_px` widens the missing set by that many px first
    {"op": "harmonize", "mask": "out:region.png", "protect": "out:eyes-lips-hair.png", "valid": "out:islands.png", "detail_px": 6, "smooth_px": 40, "lightness": 1.0, "colour": 1.0, "strength": 1.0, "surface": null}
                    soften broad lightness / colour patches inside a soft mask (white = apply) while keeping the fine detail: the image is split into detail (finer than `detail_px`, kept untouched) and the medium-scale colour under it,
                    and that medium-scale colour is pulled toward a broader average (Gaussian, `smooth_px`) of the UNPROTECTED texels; `lightness` and `colour` (0-1) say how far for each, `strength` scales both. `protect` (white = leave alone: eyes, brows, lips,
                    hair) is never changed and never contributes to the average. `valid` (white = island texels; default: everything that is not the marker colour) keeps the padding outside the islands from bleeding in. It makes an ordinary new version:
                    `compare` it with the one before, `undo` / `revert` to go back, or lower `strength`. Needs a stack in sRGB. Reports the region box and the mean absolute change.
                    ATLAS vs SURFACE: the default smooths in the flat atlas, so two sides of a UV seam (far apart in the atlas) are averaged differently and a boundary can show. With `"surface": {"body": "body", "uv": "UVMap",
                    "sigma_mm": 25, "normal_power": 2, "pad_px": 16}` the broad colour is smoothed over the BODY'S SURFACE (a Gaussian of sigma_mm over the vertices, weighted by how alike their normals are, so the front of a nose does not mix with the
                    far cheek), and the change (smooth over the surface, the same on both sides of every seam) is added to the picture through the same mask / protect weights; detail_px and smooth_px are not used (the detail stays by construction).
                    The padding around the islands is then rebuilt from the new colours (`pad_px`). Needs the body and its UV layer in the job's scene; positions are the stored (rest) mesh.
                    HYBRID (stronger interior, same seams): add "atlas": {"detail_px": 6, "smooth_px": 90, "strength": 0.8, "edge_fade_px": 24} next to "surface". The atlas-space change (stronger, island-interior smoothing) is added on top of the surface
                    result but weighted by how deep each texel is inside its island (0 on the island border, 1 from edge_fade_px in), so it vanishes toward every seam and only the continuous surface change remains there.
    {"op": "fill_outliers", "mask": "out:region.png", "mask_threshold": 0.5, "radius_px": 8, "dark_abs": null, "dark_rel": null, "bright_rel": null, "colour_delta": null, "normal_angle_deg": null, "grow_px": 1, "padding_px": 16, "mask_out": null, "preview": false}
                    inside the mask (white; none = everywhere) flag the texels that stand out from their neighbourhood, then fill ONLY those from the nearest unflagged texels (up to `padding_px`). The neighbourhood colour is a Gaussian mean (sigma `radius_px`)
                    of the unflagged texels in the mask. Criteria (give at least one, any one flags): `dark_abs` luminance below that value (as stored, 0-1); `dark_rel` luminance below this FRACTION of the neighbourhood's (0.5 = half as bright as around it);
                    `bright_rel` above this MULTIPLE of it; `colour_delta` any channel differing from the neighbourhood by more than this; `normal_angle_deg` (for a NORMAL MAP, stack colour_space Non-Color) the decoded direction (2c-1) turned more than this many degrees from the neighbourhood's mean direction.
                    On a normal map, luminance criteria (dark_abs, dark_rel, bright_rel) are meaningless: use normal_angle_deg or colour_delta. `grow_px` widens the flagged set (within the mask). `mask_out` writes the flagged texels as a picture
                    (out/<name>) so you can look before you fill; `preview: true` writes it and the counts but changes nothing (no new version). Reports flagged_texels and flagged_pct_of_mask.
    {"op": "patch", "file": "out:patch.png", "at": [x, y], "scale": 1.0, "mask": "out:m.png" | "alpha" | (none = the whole patch), "colour_space": "sRGB", "mode": "normal", "strength": 1.0, "feather_px": 6}
                    put a PICTURE (made elsewhere: painted, cropped from a photo, or generated by an image tool) onto the stack at pixel position `at` (x, y of its top-left corner, row 0 = top; default [0, 0]), scaled by `scale`,
                    through a mask (a file in the stack's size, the patch's own alpha, or the whole patch rectangle), with its own `colour_space` converted to the stack's (sRGB, Linear or Non-Color). There is NO generation backend inside this verb.
    {"op": "undo"}                                                       a new version equal to the one before the current
    {"op": "revert", "to": 2}                                            a new version equal to version 2
    {"op": "compare", "a": 1, "b": 3}                                    report the difference between two versions (no new version)
    {"op": "export", "file": "basecolor.png", "format": "PNG" | "JPEG", "quality": 90, "to_colour_space": "sRGB" | "Linear" | "Non-Color", "size": 2048, "version": N}   write the current (or version N) to out/
Returns: stack (name, colour_space, size), current version, versions (n, op, file, changed_pct and mean change against its parent), per-op results, files written.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import uv_common as UC  # noqa: E402


def resolve(p):
    if isinstance(p, dict) or L.is_id(p):
        return L.resolve(p, what="image")
    if p.startswith("out:"):
        return os.path.join(L.ARGS["out_dir"], p[4:])
    return p if os.path.isabs(p) else L.resolve(p)


def resize(a, size):
    h, w = a.shape[:2]
    if (h, w) == (size, size):
        return a
    ys = (np.arange(size) + 0.5) * h / size - 0.5
    xs = (np.arange(size) + 0.5) * w / size - 0.5
    y0, x0 = np.clip(np.floor(ys).astype(int), 0, h - 2), np.clip(np.floor(xs).astype(int), 0, w - 2)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    return (a[y0][:, x0] * (1 - fy) * (1 - fx) + a[y0][:, x0 + 1] * (1 - fy) * fx + a[y0 + 1][:, x0] * fy * (1 - fx) + a[y0 + 1][:, x0 + 1] * fy * fx)


def blur(a, px):
    """Gaussian blur (sigma px) by multiplication in the frequency domain (the sheet's edges wrap round)"""
    if px <= 0:
        return a
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi ** 2) * (px ** 2) * (fx ** 2 + fy ** 2)).astype(np.float32)
    x = a.reshape(h, w, -1)
    out = np.empty_like(x, dtype=np.float32)
    for c in range(x.shape[2]):
        out[..., c] = np.fft.irfft2(np.fft.rfft2(x[..., c]) * g, s=(h, w))
    return out.reshape(a.shape)


def load_mask(spec, rgb, size):
    if spec is None:
        return np.ones((size, size), np.float32)
    if spec == "alpha":
        return rgb[..., 3].copy()
    m = UC.load_image(resolve(spec))
    m = resize(m, size)
    return m[..., :3].mean(-1).astype(np.float32)


def feather(m, px):
    return np.clip(blur(m[..., None], px)[..., 0], 0, 1) if px > 0 else m


def apply_mode(base, top, mode):
    if mode == "normal":
        return top
    if mode == "multiply":
        return base * top
    if mode == "screen":
        return 1 - (1 - base) * (1 - top)
    if mode == "lighten":
        return np.maximum(base, top)
    if mode == "darken":
        return np.minimum(base, top)
    if mode == "colour":
        lb = (base * [0.3, 0.59, 0.11]).sum(-1, keepdims=True)
        lt = (top * [0.3, 0.59, 0.11]).sum(-1, keepdims=True)
        return np.clip(top + (lb - lt), 0, 1)
    raise RuntimeError("mode must be normal, multiply, screen, lighten, darken or colour")


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


def to_space(rgb, src, dst):
    """convert colour values between 'sRGB' and 'Linear' / 'Non-Color' (both linear data)"""
    if src == dst or {src, dst} <= {"Linear", "Non-Color"}:
        return rgb
    if src == "sRGB":
        return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    return np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.clip(rgb, 0, None) ** (1 / 2.4) - 0.055)


def harmonize_atlas(cur, reg, prot, valid, dp, sp, ls, cs, st):
    """frequency separation in the flat atlas, inside a soft mask: keep the detail (finer than dp px) and pull the medium-scale lightness / colour toward a broader average (sp px) taken from the unprotected texels only.
    Returns the new picture (a copy of cur) and the box worked on"""
    size = cur.shape[0]
    ys_, xs_ = np.nonzero(reg > 0.001)
    if not len(ys_):
        raise RuntimeError("harmonize: the mask selects nothing")
    mg = int(3 * max(dp, sp)) + 2
    y0b, y1b = max(0, ys_.min() - mg), min(size, ys_.max() + mg + 1)
    x0b, x1b = max(0, xs_.min() - mg), min(size, xs_.max() + mg + 1)
    sl = (slice(y0b, y1b), slice(x0b, x1b))
    img = cur[..., :3][sl]
    vv = valid[sl].astype(np.float32)
    pp = prot[sl]
    lw = np.array([0.2126, 0.7152, 0.0722], np.float32)

    def bv(x, wgt, s_):
        b = np.maximum(blur(wgt[..., None], s_)[..., 0], 1e-6)
        return blur(x * wgt[..., None], s_) / b[..., None]
    base = bv(img, vv, dp)
    detail = img - base
    ref_w = vv * (1 - pp)  # the broader average ignores the protected texels (eyes, brows, lips, hair) and everything outside the islands
    target = bv(img, ref_w, sp)
    lum_b, lum_t = (base @ lw)[..., None], (target @ lw)[..., None]
    w = (reg[sl] * (1 - pp) * st * vv)[..., None]
    new_lum = lum_b + w * ls * (lum_t - lum_b)
    new_chroma = (base - lum_b) + w * cs * ((target - lum_t) - (base - lum_b))
    new = new_lum + new_chroma + detail
    out = cur.copy()
    out[..., :3][sl] = np.where(vv[..., None] > 0, new, img)
    return out, (int(x0b), int(y0b), int(x1b), int(y1b))


def edge_distance(inside, n):
    """how many texels deep each island texel is, counted up to n+1 (1 = on the island's border), from n erosions"""
    m = inside.copy()
    dist = inside.astype(np.float32)
    for _ in range(int(n)):
        e = m.copy()
        e[1:, :] &= m[:-1, :]
        e[:-1, :] &= m[1:, :]
        e[:, 1:] &= m[:, :-1]
        e[:, :-1] &= m[:, 1:]
        e[0, :] = False
        e[-1, :] = False
        e[:, 0] = False
        e[:, -1] = False
        m = e
        dist += m
    return dist


def main():
    stack = L.param("stack")
    if not stack or not stack.replace("-", "").replace("_", "").isalnum():
        raise RuntimeError("stack is required: a name of letters, digits, - and _")
    ops = L.param("ops") or []
    if not ops:
        raise RuntimeError("give ops, e.g. [{\"op\": \"init\", \"image\": \"out:base.png\"}]")
    root = os.path.join(L.ARGS["job_dir"], "tex", stack)
    os.makedirs(root, exist_ok=True)
    mf = os.path.join(root, "manifest.json")
    man = json.load(open(mf)) if os.path.isfile(mf) else {"stack": stack, "colour_space": "sRGB", "size": None, "versions": [], "current": None}

    def load_v(n):
        v = next((x for x in man["versions"] if x["n"] == n), None)
        if v is None:
            raise RuntimeError(f"no version {n}; the versions are {[x['n'] for x in man['versions']]}")
        return UC.load_image(os.path.join(root, v["file"]))

    def new_version(img, op, params, parent):
        n = len(man["versions"])
        fn = f"v{n}.png"
        UC.save_image(np.clip(img, 0, 1).astype(np.float32), os.path.join(root, fn), man["colour_space"])
        pi = load_v(parent) if parent is not None else None
        ch = None
        if pi is not None:
            d = np.abs(img[..., :3] - pi[..., :3]).max(-1)
            ch = {"changed_pct": round(float((d > 0.004).mean() * 100), 2), "mean_change": round(float(d.mean()), 5)}
        man["versions"].append({"n": n, "op": op, "params": params, "file": fn, "parent": parent, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **(ch or {})})
        man["current"] = n
        return n

    results, files = [], []
    for o in ops:
        k = o.get("op")
        r = {"op": k}
        if k == "init":
            img = UC.load_image(resolve(o["image"]))
            if o.get("size"):
                img = resize(img, int(o["size"]))
            man["colour_space"] = o.get("colour_space", man["colour_space"])
            man["size"] = img.shape[0]
            if man["size"] != img.shape[1]:
                raise RuntimeError("the picture must be square (a UV sheet)")
            r["version"] = new_version(img, "init", {k2: v for k2, v in o.items() if k2 != "op"}, None)
        elif k in ("layer", "fill", "fill_missing", "patch", "fill_outliers", "harmonize"):
            if man["current"] is None:
                raise RuntimeError("start with an init op")
            cur = load_v(man["current"])
            size = cur.shape[0]
            parent = man["current"]
            if k == "layer":
                top = resize(UC.load_image(resolve(o["file"])), size)
                m = load_mask(o.get("mask"), top, size)
                if o.get("invert_mask"):
                    m = 1 - m
                m = feather(m, float(o.get("feather_px", 0))) * float(o.get("strength", 1.0))
                out = cur.copy()
                out[..., :3] = cur[..., :3] * (1 - m[..., None]) + apply_mode(cur[..., :3], top[..., :3], o.get("mode", "normal")) * m[..., None]
                r["covered_pct"] = round(float((m > 0.01).mean() * 100), 1)
            elif k == "fill":
                m = feather(load_mask(o.get("mask"), cur, size), float(o.get("feather_px", 0))) * float(o.get("strength", 1.0))
                out = cur.copy()
                out[..., :3] = cur[..., :3] * (1 - m[..., None]) + np.array(o["colour"], np.float32) * m[..., None]
            elif k == "harmonize" and o.get("surface"):
                # SURFACE-space harmonization: the broad colour field is smoothed over the body's surface (not the flat atlas), so both sides of every UV seam get the same change and no island boundary shows
                sf = o["surface"]
                body_o = bpy.data.objects.get(sf.get("body", "body"))
                if body_o is None or body_o.type != "MESH":
                    raise RuntimeError(f"harmonize surface: no mesh {sf.get('body', 'body')} in the job's scene")
                me = body_o.data
                uvn = sf.get("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
                if uvn is None or uvn not in me.uv_layers:
                    raise RuntimeError(f"harmonize surface: no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
                reg = load_mask(o.get("mask"), cur, size)
                prot = load_mask(o["protect"], cur, size) if o.get("protect") else np.zeros((size, size), np.float32)
                tv, P3, U, tl = UC.uv_arrays(me, uvn)
                tid, bary = UC.raster_ids(U, size)  # raster rows run v = 0 first; the stack's pictures run v = 1 first: flip when crossing
                inside_r = tid >= 0
                inside = inside_r[::-1]
                if o.get("valid"):
                    validm = load_mask(o["valid"], cur, size) > 0.5
                else:
                    validm = ~(np.abs(cur[..., :3] - np.array(o.get("marker", [1, 0, 1]), np.float32)) < 0.02).all(-1)
                ls, cs, st = float(o.get("lightness", 1.0)), float(o.get("colour", 1.0)), float(o.get("strength", 1.0))
                sig = float(sf.get("sigma_mm", 25)) / 1000
                npow = float(sf.get("normal_power", 2))
                padn = int(sf.get("pad_px", 16))
                lw = np.array([0.2126, 0.7152, 0.0722], np.float32)
                nv = len(me.vertices)
                co = np.empty(nv * 3)
                me.vertices.foreach_get("co", co)
                Mw = np.array(body_o.matrix_world)
                Vw = co.reshape(-1, 3) @ Mw[:3, :3].T + Mw[:3, 3]
                vn = np.empty(nv * 3)
                me.vertex_normals.foreach_get("vector", vn)
                vn = vn.reshape(-1, 3) @ (Mw[:3, :3] / max(np.linalg.norm(Mw[:3, 0]), 1e-12)).T
                _, gid = np.unique(np.round(Vw / 1e-5).astype(np.int64), axis=0, return_inverse=True)
                gid = gid.ravel()
                ng = int(gid.max()) + 1
                cnt = np.bincount(gid, minlength=ng).astype(np.float64)
                posg = np.zeros((ng, 3))
                np.add.at(posg, gid, Vw)
                posg /= cnt[:, None]
                nrg = np.zeros((ng, 3))
                np.add.at(nrg, gid, vn)
                nrg /= np.maximum(np.linalg.norm(nrg, axis=1, keepdims=True), 1e-12)
                # each group's colour: the texels at the UV corners of its vertices, weighted by validity and by "not protected"
                uvl = np.empty(len(me.loops) * 2)
                me.uv_layers[uvn].data.foreach_get("uv", uvl)
                uvl = uvl.reshape(-1, 2)
                vi = np.empty(len(me.loops), dtype=np.int64)
                me.loops.foreach_get("vertex_index", vi)
                px_ = np.clip((uvl[:, 0] * size).astype(int), 0, size - 1)
                py_ = np.clip(((1 - uvl[:, 1]) * size).astype(int), 0, size - 1)  # the stack's rows: 0 = top
                wcorner = validm[py_, px_] * (1 - prot[py_, px_])
                ccol = cur[py_, px_, :3]
                gl = gid[vi]
                gw = np.zeros(ng)
                np.add.at(gw, gl, wcorner)
                gc = np.zeros((ng, 3))
                np.add.at(gc, gl, ccol * wcorner[:, None])
                okg = gw > 1e-6
                gc[okg] /= gw[okg, None]
                gr = np.zeros(ng)
                gn = np.zeros(ng)
                np.add.at(gr, gl, reg[py_, px_])
                np.add.at(gn, gl, 1.0)
                gr /= np.maximum(gn, 1)
                from mathutils.kdtree import KDTree
                kd = KDTree(int(okg.sum()))
                src = np.nonzero(okg)[0]
                for j, g in enumerate(src):
                    kd.insert(posg[g], j)
                kd.balance()
                target = gc.copy()
                for g in np.nonzero(gr > 0.001)[0]:
                    if not okg[g]:
                        continue
                    nb = kd.find_range(posg[g], 3 * sig)
                    idx = np.array([j for _, j, _d in nb])
                    dist = np.array([_d for _, _j, _d in nb])
                    sidx = src[idx]
                    kw = np.exp(-(dist ** 2) / (2 * sig * sig)) * np.maximum(nrg[sidx] @ nrg[g], 0) ** npow * gw[sidx]
                    if kw.sum() > 1e-9:
                        target[g] = (gc[sidx] * kw[:, None]).sum(0) / kw.sum()
                lumC, lumT = gc @ lw, target @ lw
                dl = ls * (lumT - lumC)
                dch = cs * ((target - lumT[:, None]) - (gc - lumC[:, None]))
                delta_g = dl[:, None] + dch  # an RGB change per group: smooth over the surface, identical on both sides of a seam
                dg_c = delta_g[gid]  # per vertex
                tvg = dg_c[tv]  # (T, 3, 3): the change at each triangle corner
                ysr, xsr = np.nonzero(inside_r)
                tt = tid[ysr, xsr]
                b1_, b2_ = bary[ysr, xsr, 0], bary[ysr, xsr, 1]
                dimg_r = np.zeros((size, size, 3), np.float32)
                dimg_r[ysr, xsr] = (tvg[tt, 0] * (1 - b1_ - b2_)[:, None] + tvg[tt, 1] * b1_[:, None] + tvg[tt, 2] * b2_[:, None]).astype(np.float32)
                dimg = dimg_r[::-1]
                wt = (reg * (1 - prot) * st * validm).astype(np.float32)[..., None]  # texels that hold no colour (the marker) are left as they are
                new = cur.copy()
                new[..., :3] = np.where(inside[..., None], cur[..., :3] + wt * dimg, cur[..., :3])
                if o.get("atlas"):
                    # the stronger interior smoothing of the atlas mode, but faded out toward every island border (edge_fade_px), where only the surface-space change applies: continuity across seams is kept
                    at = o["atlas"]
                    ef = int(at.get("edge_fade_px", 24))
                    atl, _box = harmonize_atlas(cur, reg, prot, validm, float(at.get("detail_px", 6)), float(at.get("smooth_px", 90)), ls, cs, float(at.get("strength", st)))
                    dist = edge_distance(inside, ef)
                    t_ = np.clip((dist - 1) / max(ef, 1), 0, 1)
                    wi = (t_ * t_ * (3 - 2 * t_)).astype(np.float32)[..., None] * inside[..., None]
                    new[..., :3] = new[..., :3] + wi * (atl[..., :3] - cur[..., :3])  # the atlas mode's own change, weighted by depth into the island, added to the surface result
                    r["atlas_interior_added"] = True
                if padn > 0:  # refresh the padding around the islands from the new island colours (the old padding no longer matches)
                    f, v2 = dilate_fill(new[..., :3], inside, padn)
                    ring = (~inside) & v2
                    new[..., :3] = np.where(ring[..., None], f, new[..., :3])
                out = new
                r["surface_groups"] = int(ng)
                r["groups_changed"] = int((np.abs(delta_g).max(1) > 1e-4).sum())
                r["mean_abs_change"] = round(float(np.abs(out[..., :3] - cur[..., :3]).mean()), 5)
                dd_ = np.abs(out[..., :3] - cur[..., :3]).max(-1)
                r["island_texels_changed_pct"] = round(float((dd_[inside] > 0.004).mean() * 100), 2)
                r["largest_island_change"] = round(float(dd_[inside].max()), 3)
                r["padding_texels_rebuilt"] = int((((~inside) & (dd_ > 0.004))).sum())
            elif k == "harmonize":
                reg = load_mask(o.get("mask"), cur, size)
                prot = load_mask(o["protect"], cur, size) if o.get("protect") else np.zeros((size, size), np.float32)
                if o.get("valid"):
                    valid = load_mask(o["valid"], cur, size) > 0.5
                else:
                    valid = ~(np.abs(cur[..., :3] - np.array(o.get("marker", [1, 0, 1]), np.float32)) < 0.02).all(-1)
                out, box = harmonize_atlas(cur, reg, prot, valid, float(o.get("detail_px", 6)), float(o.get("smooth_px", 40)), float(o.get("lightness", 1.0)), float(o.get("colour", 1.0)), float(o.get("strength", 1.0)))
                r["changed_region_px"] = list(box)
                r["mean_abs_change"] = round(float(np.abs(out[..., :3][box[1]:box[3], box[0]:box[2]] - cur[..., :3][box[1]:box[3], box[0]:box[2]]).mean()), 5)
            elif k == "fill_outliers":
                inside = load_mask(o.get("mask"), cur, size) > float(o.get("mask_threshold", 0.5))
                rgb0 = cur[..., :3]
                lw = np.array([0.2126, 0.7152, 0.0722], np.float32)
                rad = float(o.get("radius_px", 8))
                ys_, xs_ = np.nonzero(inside)
                if not len(ys_):
                    raise RuntimeError("fill_outliers: the mask selects nothing")
                mg = int(3 * rad) + 2  # work on the mask's bounding box only
                y0b, y1b = max(0, ys_.min() - mg), min(size, ys_.max() + mg + 1)
                x0b, x1b = max(0, xs_.min() - mg), min(size, xs_.max() + mg + 1)
                sub_rgb, sub_in = rgb0[y0b:y1b, x0b:x1b], inside[y0b:y1b, x0b:x1b]
                good = sub_in.copy()
                flag = np.zeros_like(sub_in)
                for _pass in range(2):  # the reference colour is the neighbourhood mean of the texels not yet flagged, so the outliers do not drag it
                    wgt = good.astype(np.float32)
                    bw = np.maximum(blur(wgt[..., None], rad)[..., 0], 1e-6)
                    ref = blur(sub_rgb * wgt[..., None], rad) / bw[..., None]
                    lum, refl = sub_rgb @ lw, ref @ lw
                    f2 = np.zeros_like(sub_in)
                    if o.get("dark_abs") is not None:
                        f2 |= lum < float(o["dark_abs"])
                    if o.get("dark_rel") is not None:
                        f2 |= lum < refl * float(o["dark_rel"])
                    if o.get("bright_rel") is not None:
                        f2 |= lum > refl * float(o["bright_rel"])
                    if o.get("colour_delta") is not None:
                        f2 |= np.abs(sub_rgb - ref).max(-1) > float(o["colour_delta"])
                    if o.get("normal_angle_deg") is not None:  # for a normal map: the decoded direction (2c-1) against the neighbourhood's mean direction
                        a_ = sub_rgb * 2 - 1
                        b_ = ref * 2 - 1
                        cosang = (a_ * b_).sum(-1) / np.maximum(np.linalg.norm(a_, axis=-1) * np.linalg.norm(b_, axis=-1), 1e-6)
                        f2 |= np.degrees(np.arccos(np.clip(cosang, -1, 1))) > float(o["normal_angle_deg"])
                    flag = f2 & sub_in & (bw > 0.2)
                    good = sub_in & ~flag
                if not any(o.get(c) is not None for c in ("dark_abs", "dark_rel", "bright_rel", "colour_delta", "normal_angle_deg")):
                    raise RuntimeError("fill_outliers: give at least one of dark_abs, dark_rel, bright_rel, colour_delta")
                for _ in range(int(o.get("grow_px", 0))):
                    g = flag.copy()
                    g[1:, :] |= flag[:-1, :]
                    g[:-1, :] |= flag[1:, :]
                    g[:, 1:] |= flag[:, :-1]
                    g[:, :-1] |= flag[:, 1:]
                    flag = g & sub_in
                full_flag = np.zeros((size, size), bool)
                full_flag[y0b:y1b, x0b:x1b] = flag
                r["flagged_texels"] = int(full_flag.sum())
                r["flagged_pct_of_mask"] = round(float(full_flag.sum() / max(inside.sum(), 1) * 100), 3)
                if o.get("mask_out"):
                    pth = os.path.join(L.ARGS["out_dir"], o["mask_out"])
                    UC.save_image(np.repeat(full_flag[..., None].astype(np.float32), 3, axis=2), pth, "Non-Color")
                    files.append(pth)
                    r["mask_file"] = o["mask_out"]
                if o.get("preview"):
                    r["preview"] = True
                    results.append(r)
                    continue
                f, valid = dilate_fill(cur[..., :3], ~full_flag, float(o.get("padding_px", 16)))
                out = cur.copy()
                out[..., :3] = f
                r["filled_texels"] = int((valid & full_flag).sum())
            elif k == "fill_missing":
                mk = np.array(o.get("marker", [1, 0, 1]), np.float32)
                miss = (np.abs(cur[..., :3] - mk) < float(o.get("tolerance", 0.02))).all(-1)
                if o.get("mask") is not None:  # also these texels (a picture, white = missing; e.g. uv_rebake's <name>-misses.png), widened by grow_px
                    miss = miss | (load_mask(o["mask"], cur, size) > float(o.get("mask_threshold", 0.5)))
                for _ in range(int(o.get("grow_px", 0))):
                    g = miss.copy()
                    g[1:, :] |= miss[:-1, :]
                    g[:-1, :] |= miss[1:, :]
                    g[:, 1:] |= miss[:, :-1]
                    g[:, :-1] |= miss[:, 1:]
                    miss = g
                out = cur.copy()
                if o.get("colour") is not None:
                    out[miss, :3] = np.array(o["colour"], np.float32)
                    filled = int(miss.sum())
                else:
                    f, valid = dilate_fill(cur[..., :3], ~miss, float(o.get("padding_px", 32)))
                    out[..., :3] = f
                    filled = int((valid & miss).sum())
                r["missing_texels"] = int(miss.sum())
                r["filled_texels"] = filled
            else:
                pic = UC.load_image(resolve(o["file"]))
                sc = float(o.get("scale", 1.0))
                if sc != 1.0:
                    h2, w2 = max(1, round(pic.shape[0] * sc)), max(1, round(pic.shape[1] * sc))
                    ys = (np.arange(h2) + 0.5) * pic.shape[0] / h2 - 0.5
                    xs = (np.arange(w2) + 0.5) * pic.shape[1] / w2 - 0.5
                    y0, x0 = np.clip(np.floor(ys).astype(int), 0, pic.shape[0] - 2), np.clip(np.floor(xs).astype(int), 0, pic.shape[1] - 2)
                    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
                    pic = (pic[y0][:, x0] * (1 - fy) * (1 - fx) + pic[y0][:, x0 + 1] * (1 - fy) * fx + pic[y0 + 1][:, x0] * fy * (1 - fx) + pic[y0 + 1][:, x0 + 1] * fy * fx)
                ph, pw = pic.shape[:2]
                ax0, ay0 = [int(v) for v in o.get("at", [0, 0])]
                x0c, y0c, x1c, y1c = max(0, ax0), max(0, ay0), min(size, ax0 + pw), min(size, ay0 + ph)
                if x1c <= x0c or y1c <= y0c:
                    raise RuntimeError(f"the patch {pw}x{ph} at {ax0},{ay0} lies outside the {size}x{size} sheet")
                sub = pic[y0c - ay0:y1c - ay0, x0c - ax0:x1c - ax0]
                rgb = to_space(sub[..., :3], o.get("colour_space", man["colour_space"]), man["colour_space"])
                ms = o.get("mask")
                m = np.zeros((size, size), np.float32)
                if ms is None:
                    m[y0c:y1c, x0c:x1c] = 1.0
                elif ms == "alpha":
                    m[y0c:y1c, x0c:x1c] = sub[..., 3]
                else:
                    m = load_mask(ms, cur, size)
                    m[:y0c] = 0
                    m[y1c:] = 0
                    m[:, :x0c] = 0
                    m[:, x1c:] = 0
                m = feather(m, float(o.get("feather_px", 6))) * float(o.get("strength", 1.0))
                full = cur[..., :3].copy()
                full[y0c:y1c, x0c:x1c] = apply_mode(cur[y0c:y1c, x0c:x1c, :3], rgb, o.get("mode", "normal"))
                out = cur.copy()
                out[..., :3] = cur[..., :3] * (1 - m[..., None]) + full * m[..., None]
                r["patched_pct"] = round(float((m > 0.01).mean() * 100), 2)
                r["patch_px"] = [pw, ph]
            r["version"] = new_version(out, k, {k2: v for k2, v in o.items() if k2 != "op"}, parent)
            r.update({k3: man["versions"][-1][k3] for k3 in ("changed_pct", "mean_change") if k3 in man["versions"][-1]})
        elif k in ("undo", "revert"):
            if man["current"] is None:
                raise RuntimeError("nothing to revert: no versions yet")
            if k == "undo":
                to = man["versions"][man["current"]]["parent"]
                if to is None:
                    raise RuntimeError("version 0 has nothing before it")
            else:
                to = int(o["to"])
            r["from"], r["to"] = man["current"], to
            r["version"] = new_version(load_v(to), k, {"to": to}, man["current"])
        elif k == "compare":
            a, b = load_v(int(o["a"])), load_v(int(o["b"]))
            d = np.abs(a[..., :3] - b[..., :3]).max(-1)
            r.update({"a": int(o["a"]), "b": int(o["b"]), "changed_pct": round(float((d > 0.004).mean() * 100), 2), "mean_change": round(float(d.mean()), 5), "max_change": round(float(d.max()), 3)})
        elif k == "export":
            n = int(o["version"]) if o.get("version") is not None else man["current"]
            img = load_v(n)
            if o.get("size"):
                img = resize(img, int(o["size"]))
            cs = o.get("to_colour_space")
            rgb = img[..., :3].copy()
            if cs and cs != man["colour_space"]:
                if man["colour_space"] == "sRGB" and cs in ("Linear", "Non-Color"):
                    rgb = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
                elif man["colour_space"] in ("Linear", "Non-Color") and cs == "sRGB":
                    rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.clip(rgb, 0, None) ** (1 / 2.4) - 0.055)
            fmt = str(o.get("format", "PNG")).upper()
            path = os.path.join(L.ARGS["out_dir"], o["file"])
            UC.save_image(np.clip(rgb, 0, 1).astype(np.float32), path, cs or man["colour_space"], fmt, int(o.get("quality", 90)))
            files.append(path)
            r.update({"file": o["file"], "version": n, "format": fmt, "colour_space": cs or man["colour_space"], "size": int(img.shape[0])})
        else:
            raise RuntimeError(f"unknown op {k}")
        results.append(r)
    json.dump(man, open(mf, "w"), indent=1)
    L.finish({"stack": {"name": stack, "colour_space": man["colour_space"], "size": man["size"]}, "current": man["current"],
              "versions": [{kk: v[kk] for kk in ("n", "op", "file", "parent", "changed_pct", "mean_change") if kk in v} for v in man["versions"]], "ops": results,
              "folder": f"work/{L.ARGS['job']}/tex/{stack}"}, files=files, save=False)


L.run(main)
