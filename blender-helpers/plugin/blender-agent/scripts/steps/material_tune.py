"""material_tune — tune the colour and contrast of a material's BASE-COLOUR picture (brightness, contrast, soft cap on pale highlights, saturation, target mean colour) as a NEW picture, and re-point the material's image node at it. Alpha, UVs, geometry, the other maps, other materials and the number of linked users are not touched. Measures the picture before and after, and can measure the EXPORTED material from a GLB. Saves a checkpoint (not with dry_run).

params:
  materials   names / globs of the materials (required). The Image Texture node that feeds Base Color (through any chain) is tuned; a picture shared with a material NOT listed keeps its old version for that material
  exposure_stops  default 0: brightness in stops (+1 doubles, applied in linear light)
  contrast    default 1: the luminance's spread around its mean (opaque pixels) is multiplied by this (0.6 = flatter); the colour keeps its hue
  highlight_knee_percentile  optional (e.g. 70): luminance above that percentile of the opaque pixels is compressed ...
  highlight_gain  default 0.5 (with the knee): ... to knee + (value - knee) x gain, so pale / bright detail is toned down without flattening the rest
  saturation  default 1: 0 = grey, 1 = unchanged, 1.3 = more colourful
  target_mean optional [r, g, b] (0..1, sRGB as seen): last step, per-channel gain so the opaque pixels' mean colour is this
  name        suffix for the new picture (default "tuned"): "<picture>-<name>" (the old picture stays in the file, unused by this material: reversible by pointing the node back)
  verify_export  optional {"objects": ["<object>", ...]}: exports those objects (and their children) to out/<name>-verify.glb and measures the exported base-colour image of each listed material (size, bytes, alphaMode, mean colour of the opaque pixels)
  dry_run     true: the measurements and the comparison picture only
Returns per material: the node and old / new picture, `before` / `after` stats over the OPAQUE pixels (alpha > 0.5): mean sRGB, luminance mean / std, p5 / p50 / p95 / p99, share of pixels brighter than 0.7, mean saturation, alpha coverage; `alpha_identical` (the alpha channel is bit-for-bit the same), `users` (objects, meshes: unchanged), the comparison picture out/<material>-tune-compare.png (before | after on grey), and `export` when asked. Linear in effect: exposure first (linear light), then contrast + knee on the luminance (perceptual, sRGB values), then saturation, then target mean; the result is clipped to 0..1.
Limits: whole-picture colour operations (no masks, no local tone mapping); the picture's own lighting is not removed (see texture_make photo `delight`); a shared picture is replaced only on the listed materials' nodes."""
import fnmatch
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402

LUM = np.array([0.299, 0.587, 0.114])


def srgb2lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin2srgb(c):
    c = np.clip(c, 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def base_image_node(mat):
    """the Image Texture node that feeds Principled Base Color (following links through any other nodes)"""
    if not mat.use_nodes:
        return None
    pr = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if pr is None:
        return None
    seen = set()

    def walk(sock):
        for lk in sock.links:
            n = lk.from_node
            if n in seen:
                continue
            seen.add(n)
            if n.type == "TEX_IMAGE":
                return n
            for i in n.inputs:
                r = walk(i)
                if r is not None:
                    return r
        return None
    return walk(pr.inputs["Base Color"])


def pixels(img):
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4).astype(np.float64)
    if img.is_float:
        px[..., :3] = lin2srgb(px[..., :3])
    return px


def stats(rgb, alpha):
    m = alpha > 0.5
    if not m.any():
        m = np.ones(alpha.shape, bool)
    v = rgb[m]
    lum = v @ LUM
    mx, mn = v.max(axis=1), v.min(axis=1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    return {"mean_srgb": [round(float(x), 4) for x in v.mean(axis=0)], "luminance_mean": round(float(lum.mean()), 4), "luminance_std": round(float(lum.std()), 4),
            "luminance_p5_p50_p95_p99": [round(float(x), 4) for x in np.percentile(lum, [5, 50, 95, 99])], "share_brighter_than_0.7": round(float((lum > 0.7).mean()), 4),
            "mean_saturation": round(float(sat.mean()), 4), "alpha_coverage": round(float((alpha > 0.5).mean()), 4), "opaque_pixels": int(m.sum())}


def tune(px, p):
    rgb = px[..., :3].copy()
    alpha = px[..., 3]
    m = alpha > 0.5
    if not m.any():
        m = np.ones(alpha.shape, bool)
    ex = float(p.get("exposure_stops", 0.0))
    if ex:
        rgb = lin2srgb(srgb2lin(rgb) * (2.0 ** ex))
    ct = float(p.get("contrast", 1.0))
    kp = p.get("highlight_knee_percentile")
    if ct != 1.0 or kp is not None:
        lum = rgb @ LUM
        lm = float(lum[m].mean())
        L2 = lm + (lum - lm) * ct
        if kp is not None:
            knee = float(np.percentile(L2[m], float(kp)))
            hg = float(p.get("highlight_gain", 0.5))
            L2 = np.where(L2 > knee, knee + (L2 - knee) * hg, L2)
        ratio = np.clip(L2 / np.maximum(lum, 1e-4), 0.0, 4.0)
        rgb = rgb * ratio[..., None]
    sat = float(p.get("saturation", 1.0))
    if sat != 1.0:
        g = (rgb @ LUM)[..., None]
        rgb = g + (rgb - g) * sat
    tm = p.get("target_mean")
    if tm:
        cur = np.clip(rgb[m].mean(axis=0), 1e-4, None)
        rgb = rgb * (np.array(tm, dtype=float) / cur)[None, None, :]
    return np.clip(rgb, 0.0, 1.0)


def new_image(name, rgb, alpha, src):
    h, w = alpha.shape
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.colorspace_settings.name = "sRGB"
    img.alpha_mode = src.alpha_mode if src.alpha_mode in ("STRAIGHT", "PREMUL", "CHANNEL_PACKED", "NONE") else "STRAIGHT"
    out = np.concatenate([rgb, alpha[..., None]], axis=2).astype(np.float32)
    img.pixels.foreach_set(out.ravel())
    img.update()
    return img


def compare_png(path, a_rgb, a_alpha, b_rgb, b_alpha, h_out=400):
    def prep(rgb, alpha):
        g = np.full(rgb.shape, 0.5)
        c = rgb * alpha[..., None] + g * (1 - alpha[..., None])
        H, W = c.shape[:2]
        k = max(1, H // h_out)
        c = c[:H // k * k, :W // k * k].reshape(H // k, k, W // k, k, 3).mean(axis=(1, 3))
        return c
    A, B = prep(a_rgb, a_alpha), prep(b_rgb, b_alpha)
    sheet = np.concatenate([A, np.full((A.shape[0], 6, 3), 0.1), B], axis=1)
    im = bpy.data.images.new("cmp", sheet.shape[1], sheet.shape[0], alpha=False)
    im.colorspace_settings.name = "sRGB"
    px = np.concatenate([sheet[::-1], np.ones(sheet.shape[:2] + (1,))], axis=2).astype(np.float32)
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = "PNG"
    im.save()
    bpy.data.images.remove(im)


def glb_materials(path):
    with open(path, "rb") as f:
        data = f.read()
    jl, jt = struct.unpack("<II", data[12:20])
    js = json.loads(data[20:20 + jl].decode("utf-8"))
    off = 20 + jl
    bl, bt = struct.unpack("<II", data[off:off + 8])
    binb = data[off + 8:off + 8 + bl]
    out = {}
    tmp_dir = os.path.dirname(path)
    for mi, m in enumerate(js.get("materials", [])):
        info = {"alphaMode": m.get("alphaMode", "OPAQUE"), "doubleSided": bool(m.get("doubleSided", False)), "baseColorFactor": m.get("pbrMetallicRoughness", {}).get("baseColorFactor")}
        bct = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if bct is not None:
            tx = js["textures"][bct["index"]]
            im = js["images"][tx["source"]]
            bv = js["bufferViews"][im["bufferView"]]
            raw = binb[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]]
            fn = os.path.join(tmp_dir, f"_verify_{mi}.png")
            with open(fn, "wb") as f:
                f.write(raw)
            ii = bpy.data.images.load(fn)
            px = pixels(ii)
            info.update({"image_mime": im.get("mimeType"), "image_bytes": len(raw), "image_px": list(ii.size), "export_stats": stats(px[..., :3], px[..., 3])})
            bpy.data.images.remove(ii)
            os.remove(fn)
        out[m.get("name")] = info
    return out


def main():
    pats = L.param("materials") or []
    if isinstance(pats, str):
        pats = [pats]
    if not pats:
        raise RuntimeError("give `materials` (names or globs)")
    mats = [m for m in bpy.data.materials if any(fnmatch.fnmatchcase(m.name, g) for g in pats)]
    if not mats:
        raise RuntimeError(f"no material matches {pats}")
    dry = bool(L.param("dry_run", False))
    suffix = str(L.param("name", "tuned"))
    p = {k: L.param(k) for k in ("exposure_stops", "contrast", "highlight_knee_percentile", "highlight_gain", "saturation", "target_mean") if L.param(k) is not None}
    if not p:
        raise RuntimeError("nothing to tune: give contrast, saturation, exposure_stops, highlight_knee_percentile and / or target_mean")
    rows = []
    out_dir = L.ARGS["out_dir"]
    done_imgs = {}
    for mat in mats:
        node = base_image_node(mat)
        if node is None or node.image is None:
            rows.append({"material": mat.name, "skipped": "no Image Texture node feeds Base Color"})
            continue
        src = node.image
        px = pixels(src)
        rgb0, alpha = px[..., :3], px[..., 3]
        key = src.name
        if key not in done_imgs:
            rgb1 = tune(px, p)
            done_imgs[key] = rgb1
        rgb1 = done_imgs[key]
        users = [o.name for o in bpy.data.objects if o.type == "MESH" and any(s.material is mat for s in o.material_slots)]
        meshes = {o.data.name for o in bpy.data.objects if o.type == "MESH" and any(s.material is mat for s in o.material_slots)}
        row = {"material": mat.name, "node": node.name, "old_image": src.name, "size": list(src.size), "before": stats(rgb0, alpha), "after": stats(rgb1, alpha), "alpha_identical": True,
               "users": {"objects": len(users), "meshes": len(meshes)}}
        os.makedirs(out_dir, exist_ok=True)
        cmp_path = os.path.join(out_dir, f"{mat.name}-tune-compare.png")
        compare_png(cmp_path, rgb0, alpha, rgb1, alpha)
        row["comparison"] = os.path.basename(cmp_path)
        if not dry:
            nm = f"{src.name}-{suffix}"
            img = bpy.data.images.get(nm)
            if img is None:
                img = new_image(nm, rgb1, alpha, src)
                img.pack()
            node.image = img
            row["new_image"] = img.name
            row["alpha_identical"] = bool(np.array_equal(pixels(img)[..., 3].astype(np.float32), alpha.astype(np.float32)))
        rows.append(row)
    exp = None
    ve = L.param("verify_export")
    if ve and not dry:
        roots = [bpy.data.objects[n] for n in ve.get("objects", []) if n in bpy.data.objects]
        if not roots:
            raise RuntimeError("verify_export.objects: none found")
        vl = bpy.context.view_layer
        allo = [x for r in roots for x in [r, *r.children_recursive]]
        linked_tmp = []
        for o in allo:   # objects that are not in the scene (an archived tree) are linked for the export and unlinked again
            if o.name not in vl.objects:
                bpy.context.scene.collection.objects.link(o)
                linked_tmp.append(o)
        vl.update()
        for o in vl.objects:
            o.select_set(False)
        for o in allo:
            if o.name in vl.objects:
                o.select_set(True)
        gl = os.path.join(out_dir, f"{suffix}-verify.glb")
        bpy.ops.export_scene.gltf(filepath=gl, export_format="GLB", use_selection=True, export_apply=False)
        for o in linked_tmp:
            bpy.context.scene.collection.objects.unlink(o)
        exp = glb_materials(gl)
        exp = {k: v for k, v in exp.items() if any(fnmatch.fnmatchcase(k, g) for g in pats)}
        for r in rows:
            if "export" not in r and r.get("material") in exp:
                r["export"] = exp[r["material"]]
    L.finish({"materials": len(rows), "dry_run": dry, "settings": p, "rows": [{k: v for k, v in r.items()} for r in rows]}, save=not dry)


L.run(main)
