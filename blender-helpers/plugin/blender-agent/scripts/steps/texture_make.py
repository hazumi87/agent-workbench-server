"""texture_make — generate a TILEABLE procedural texture set (colour, normal, roughness, and alpha for leaves) from a preset, make a PBR material from it that survives the glTF export, and optionally lay it on named meshes with a metre-scaled box projection. No lighting, no ambient occlusion, no baking from a scene: the pictures are pattern generators (the weave and tile presets paint a little crevice darkening into the colour, like any hand-painted texture). Saves a checkpoint (not with dry_run).
presets (all periodic, so they repeat without seams): "weave" (a woven strap or sling: `threads` per repeat, default 12; `colour` = the horizontal threads, `colour2` = the vertical ones for a two-colour checker), "fabric" (a fine cushion weave, `threads` 40), "tiles" (a grid of tiles with grout: `nx`, `ny` tiles per repeat, `gap` fraction (0 = no grout and no tile-edge shading at all), `grout` colour, `variation`, `palette` [[r,g,b], ...]: each tile picks one of these colours and mottles towards another: brown / grey / green slate), "slate" (a CONTINUOUS slate surface, no grout or borders: `palette` [[r,g,b], ...] (default brown/grey/green-grey), `scale` patch size as a fraction of the picture (default 0.18 = large clouds), `grain`, `strata`), "diamond" (woven fabric with nested ZIGZAG diamond outlines, one diamond per repeat: `colour` ground thread (cream), `colour2` motif thread (grey), `rings` 4, `line` 0.30, `zigzag` 0.20, `zz_freq` 8, `threads` 80 across one repeat), "deck" (composite decking; `gap` 0 = no joint shading at all; `grain_dir` "u" (default, grain along the boards = U/X) or "v" (across U, for boards laid the other way): `boards` per repeat, `gap`, `variation` between boards (0.06 = subtle), long grain running along the picture's horizontal = U), "grille" (a fine perforated speaker grille: `nx`, `ny` holes per repeat, `hole` radius fraction, `colour` plate, `dark` hole colour, `staggered`), "grass" (short lawn: `colour`, `colour2`), "soil" (bare soil or mulch with small stones: `colour` the soil, `stones` the STONE COLOUR as [r, g, b] (NOT a count: a number fails with "too many indices"), `stone_amount` 0.14 the fraction covered by stones (0.05 = few, 0.2 = many), `rough` 0.95 (matte)), "photo" (a seamless colour sheet cut from an EXISTING picture, opaque: `args.image` = a name of a picture in the file or a file path (only read, never written), `args.region` [x0, y0, x1, y1] fractions from the TOP-LEFT (the largest centred square inside is used; default the whole picture) or `args.crop_px` [x, y, width, height] in the ROTATED picture's pixels (exact; same square rule; the report gives `rect_asked_px_xywh` and the square actually used `crop_at_px` / `crop_px`), `args.rotate_cw_deg` 0 | 90 | 180 | 270 (raw stored pixels: a phone portrait photo needs 90), `args.roughness` 0.85, `args.delight` true | {"radius_frac": 0.25, "strength": 1.0, "max_gain": 1.8} (default off: divide the sheet by its own blurred luminance so large-scale light / shade gradients are flattened; an APPROXIMATE flat-field correction, the report gives the method and the before / after numbers and the limits; shadows between leaves and colour casts remain); `args.tile` "mirror" (default: the crop is mirrored 2 x 2 into the `size_px` sheet; seamless but visibly symmetric) | "blend" (the crop and itself shifted by half a picture cross-faded: seamless, no symmetry, some ghosting); `tile_m` is the size of the whole sheet; flat normal map, geometric normals untouched), "leaf" (an RGBA atlas of small glossy oval leaves with irregular edges, veins and a midrib: `leaves` count, `length` [min, max] as a fraction of the picture, `gloss`; the alpha is cut out: blend mode CLIP).
params:
  name        material / file stem   [required]
  preset      one of the above       [required]
  size_px     picture size (default 512; 1024 for the leaf atlas)
  seed        default 1
  colour      [r, g, b] in 0..1 as you SEE them (sRGB): the preset's base colour
  grout, colour2, ... any other argument of the preset as listed above (passed through as `args`: {"nx": 6, "ny": 6, "gap": 0.05, "grout": [0.08,0.08,0.08]})
  normal_strength  default from the preset
  assign      {"objects": ["Cushion*"], "shared": "keep" | "split" | "all", "tile_m": 0.5, "mapping": "box" | "keep", "uv_layer": "UVMap", "overwrite_uv": false}: the material goes on every slot of those meshes, once per MESH: objects that SHARE a mesh (linked copies from scene_instance) stay linked and the glTF still writes it once; `shared` "keep" (default) refuses when a mesh is also used by an object outside `objects`, "split" gives the selected objects one new mesh (linked among themselves) and leaves the others alone, "all" changes the shared mesh for every user (reported); with "box" a new UV set (first layer, name `uv_layer`) is made from the mesh's own coordinates times its scale, projected on each face's dominant axis, so ONE picture repeat covers `tile_m` metres; a mesh that already has a layer of that name is refused unless overwrite_uv; "keep" uses the UVs the mesh has
  dry_run     true: generate nothing saved, report what would happen
Writes out/<name>-albedo.png (RGBA for leaf), -normal.png (OpenGL tangent space), -roughness.png and packs the images into the file (they travel with the checkpoint and into the export).
Returns: material, pictures (size, mean colour, alpha coverage), assignment (objects, UV layer made, tile_m, a face count), notes.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _texgen as TG  # noqa: E402


def srgb_to_linear(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _img(name, arr, srgb, alpha=None):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=alpha is not None)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"  # set BEFORE the pixels: changing it afterwards resets the buffer
    if alpha is not None:
        img.alpha_mode = "STRAIGHT"
    rgb = arr if arr.ndim == 3 else np.repeat(arr[..., None], 3, axis=2)
    # a default (byte) image stores `pixels` raw: the values written ARE the file's sRGB values, so no linear conversion here
    a = np.ones((h, w)) if alpha is None else alpha
    px = np.concatenate([rgb, a[..., None]], axis=2).astype(np.float32)
    img.pixels.foreach_set(px.ravel())
    img.update()
    return img


def photo_tile(args, size):
    """preset "photo": a seamless-by-mirroring colour sheet cut from an EXISTING picture (nothing generated, the picture is only read): the largest square inside `region` (fractions from the TOP-LEFT of the picture after `rotate_cw_deg`, default the whole picture, centred) is resampled to size/2 and mirrored into a 2 x 2 sheet of `size` px, so it repeats without a seam (one repeat covers `tile_m` metres on the mesh). Opaque, a FLAT normal map, one roughness. `delight` (default off; true or {"radius_frac": 0.25, "strength": 1.0, "max_gain": 1.8}) divides the sheet by its own blurred luminance (a periodic Gaussian of radius_frac x size px) so large-scale brightness gradients (a lit and a shaded side of the crown) are flattened: an APPROXIMATE flat-field correction, not a proof that the photographed lighting is gone."""
    src = args.get("image")
    if not src:
        raise RuntimeError("preset photo: args.image (a name of a picture in the file or a file path) is required")
    img = bpy.data.images.get(src)
    loaded = False
    if img is None:
        if not os.path.isfile(src):
            raise RuntimeError(f"preset photo: no image named {src!r} in the file and no such file")
        img = bpy.data.images.load(src, check_existing=True)
        loaded = True
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    src_is_float = bool(img.is_float)
    px = px.reshape(H, W, 4)[::-1]   # row 0 = top
    if src_is_float:
        px = px.copy()
        px[..., :3] = np.where(px[..., :3] <= 0.0031308, px[..., :3] * 12.92, 1.055 * np.power(np.maximum(px[..., :3], 0), 1 / 2.4) - 0.055)
    alpha_mean = float(px[..., 3].mean())
    rot = int(args.get("rotate_cw_deg", 0)) % 360
    if rot not in (0, 90, 180, 270):
        raise RuntimeError("photo.rotate_cw_deg: 0, 90, 180 or 270")
    if rot:
        px = np.ascontiguousarray(np.rot90(px, k=-(rot // 90)))
    H, W = px.shape[:2]
    if args.get("crop_px"):   # an exact rectangle [x, y, width, height] in the ROTATED picture's pixels (overrides region)
        cx_, cy_, cw_, ch_ = [int(v) for v in args["crop_px"]]
        if cx_ < 0 or cy_ < 0 or cx_ + cw_ > W or cy_ + ch_ > H:
            raise RuntimeError(f"photo.crop_px {args['crop_px']} is outside the {W} x {H} picture (after rotate_cw_deg)")
        x0, y0, x1, y1 = cx_, cy_, cx_ + cw_, cy_ + ch_
    else:
        reg = args.get("region") or [0.0, 0.0, 1.0, 1.0]
        x0, y0, x1, y1 = int(reg[0] * W), int(reg[1] * H), int(reg[2] * W), int(reg[3] * H)
    rect_asked = [x0, y0, x1 - x0, y1 - y0]
    cw, ch = x1 - x0, y1 - y0
    side = min(cw, ch)
    if side < 16:
        raise RuntimeError(f"photo.region is only {cw} x {ch} px: too small")
    cx0, cy0 = x0 + (cw - side) // 2, y0 + (ch - side) // 2
    crop = px[cy0:cy0 + side, cx0:cx0 + side, :3].astype(np.float64)
    tile_mode = args.get("tile", "mirror")
    if tile_mode not in ("mirror", "blend"):
        raise RuntimeError("photo.tile: mirror | blend")
    half = max(8, int(size) // 2) if tile_mode == "mirror" else max(16, int(size))
    if side >= 2 * half:   # a big source: average k x k blocks first
        k = side // half
        n = (side // k) * k
        crop = crop[:n, :n].reshape(n // k, k, n // k, k, 3).mean(axis=(1, 3))
    ii = np.linspace(0, crop.shape[0] - 1, half)
    i0 = np.floor(ii).astype(int)
    i1 = np.minimum(i0 + 1, crop.shape[0] - 1)
    fr = (ii - i0)[:, None, None]
    crop = crop[i0] * (1 - fr) + crop[i1] * fr
    fr = (ii - i0)[None, :, None]
    crop = crop[:, i0] * (1 - fr) + crop[:, i1] * fr
    if tile_mode == "mirror":
        top = np.concatenate([crop, crop[:, ::-1]], axis=1)
        sheet = np.concatenate([top, top[::-1]], axis=0)    # 2 x 2 mirrored: periodic (but visibly symmetric)
    else:
        # offset-blend: the crop and the crop shifted by half a picture are cross-faded with a window that is 1 in the middle and 0 on the edges, so the sheet is periodic without symmetry (some ghosting where the two overlap)
        n_ = crop.shape[0]
        t_ = (np.arange(n_) + 0.5) / n_
        w1 = np.sin(np.pi * t_) ** 2
        w = w1[:, None] * w1[None, :]
        sh = np.roll(np.roll(crop, n_ // 2, axis=0), n_ // 2, axis=1)
        sheet = crop * w[..., None] + sh * (1 - w[..., None])
    S = sheet.shape[0]
    lum = sheet @ np.array([0.299, 0.587, 0.114])
    rep = {"source": src, "source_px": [W, H], "rect_asked_px_xywh": rect_asked, "crop_px": [side, side], "crop_at_px": [cx0, cy0], "crop_note": "the largest centred SQUARE inside the asked rectangle is used (crop_at_px is its top-left in the rotated picture)", "sheet_px": S, "rotate_cw_deg": rot,
           "mean_colour_srgb_before": [round(float(x), 3) for x in sheet.reshape(-1, 3).mean(0)], "source_alpha_mean": round(alpha_mean, 3), "tile": tile_mode, "delight": None,
           "warning": ("the source has transparent pixels (mean alpha %.2f): their RGB is used as stored (often a fill colour); crop inside the opaque leafy area with `region`" % alpha_mean) if alpha_mean < 0.97 else None}
    dl = args.get("delight")
    if dl:
        dl = {} if dl is True else dict(dl)
        rad = float(dl.get("radius_frac", 0.25)) * S
        stn = float(dl.get("strength", 1.0))
        mg = float(dl.get("max_gain", 1.8))
        fy = np.fft.fftfreq(S)[:, None]
        fx = np.fft.fftfreq(S)[None, :]
        gauss = np.exp(-2 * (np.pi ** 2) * (rad ** 2) * (fx ** 2 + fy ** 2))
        low = np.real(np.fft.ifft2(np.fft.fft2(lum) * gauss))
        low = np.maximum(low, 1e-3)
        gain = np.clip((lum.mean() / low) ** stn, 1.0 / mg, mg)
        out = np.clip(sheet * gain[..., None], 0, 1)
        lum2 = out @ np.array([0.299, 0.587, 0.114])
        low2 = np.real(np.fft.ifft2(np.fft.fft2(lum2) * gauss))
        rep["delight"] = {"method": "flat-field: each pixel multiplied by (mean luminance / periodic Gaussian-blurred luminance)^strength, gain limited to 1/max_gain..max_gain, applied equally to R, G, B (hue kept)",
                          "radius_px": round(rad, 1), "strength": stn, "max_gain": mg,
                          "low_frequency_luminance_std_before": round(float(low.std()), 4), "low_frequency_luminance_std_after": round(float(low2.std()), 4),
                          "luminance_std_before": round(float(lum.std()), 4), "luminance_std_after": round(float(lum2.std()), 4),
                          "residual_limits": ["only brightness variation larger than the radius is flattened; shadows between leaves, per-leaf highlights and colour casts of the photographed light remain",
                                              "the correction is a ratio on the picture's own brightness, so a genuinely dark or light patch of foliage is also evened out",
                                              "an approximation: it does not prove the photographed lighting is gone"]}
        sheet = out
        rep["mean_colour_srgb_after"] = [round(float(x), 3) for x in sheet.reshape(-1, 3).mean(0)]
    if loaded:
        bpy.data.images.remove(img)   # the picture was only read (a loaded file is never written)
    rough = float(args.get("roughness", 0.85))
    return {"albedo": np.clip(sheet[::-1], 0, 1), "height": np.full((S, S), 0.5), "roughness": np.full((S, S), rough), "alpha": None, "normal_strength": 0.5}, rep


def make_set(name, preset, size, seed, args, normal_strength=None, colour=None, out_dir=None, tex=None):
    gen = TG.PRESETS.get(preset)
    kw = dict(args or {})
    if colour is not None:
        kw["colour"] = tuple(float(x) for x in colour)
    t = tex if tex is not None else gen(size, seed=seed, **kw)   # tex: a ready set from another verb (a photo atlas)
    alb, alpha = t["albedo"], t.get("alpha")
    nrm = TG.normal_from_height(t["height"], normal_strength or t.get("normal_strength", 2.0))
    imgs = {"albedo": _img(f"{name}-albedo", alb, True, alpha), "normal": _img(f"{name}-normal", nrm, False), "roughness": _img(f"{name}-roughness", t["roughness"], False)}
    files = {}
    if out_dir:
        for k, im in imgs.items():
            path = os.path.join(out_dir, f"{name}-{k}.png")
            im.filepath_raw = path
            im.file_format = "PNG"
            im.save()
            files[k] = path
            if k == "albedo":
                chk = bpy.data.images.load(path)
                buf = np.empty(chk.size[0] * chk.size[1] * 4, dtype=np.float32)
                chk.pixels.foreach_get(buf)
                t["file_mean_srgb"] = buf.reshape(-1, 4)[:, :3].mean(0)
                bpy.data.images.remove(chk)
    for im in imgs.values():
        im.pack()
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    ta = nt.nodes.new("ShaderNodeTexImage")
    ta.image = imgs["albedo"]
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = imgs["normal"]
    tr = nt.nodes.new("ShaderNodeTexImage")
    tr.image = imgs["roughness"]
    for n in (ta, tn, tr):
        nt.links.new(uv.outputs["UV"], n.inputs["Vector"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = 1.0
    nt.links.new(ta.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(tr.outputs["Color"], b.inputs["Roughness"])
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    if alpha is not None:
        gt = nt.nodes.new("ShaderNodeMath")  # alpha > 0.5: the pattern the glTF exporter reads as alphaMode MASK (cutoff 0.5), so overlapping cards need no sorting
        gt.operation = "GREATER_THAN"
        gt.inputs[1].default_value = 0.5
        nt.links.new(ta.outputs["Alpha"], gt.inputs[0])
        nt.links.new(gt.outputs["Value"], b.inputs["Alpha"])
        mat.use_backface_culling = False
    return mat, imgs, files, t


def box_uv(o, tile_m, layer):
    me = o.data
    sc = o.matrix_world.to_scale()
    uvl = me.uv_layers.get(layer) or me.uv_layers.new(name=layer)
    me.uv_layers.active = uvl
    n = 0
    for p in me.polygons:
        nr = p.normal
        ax = max(range(3), key=lambda i: abs(nr[i]))
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            q = (co.x * sc.x, co.y * sc.y, co.z * sc.z)
            uv = (q[1], q[2]) if ax == 0 else ((q[0], q[2]) if ax == 1 else (q[0], q[1]))
            uvl.data[li].uv = (uv[0] / tile_m, uv[1] / tile_m)
        n += 1
    # the layer must be the FIRST one for TEXCOORD_0: move it to the front by recreating the order is not possible in place; refuse upstream if another layer exists first
    return n


def main():
    name, preset = L.param("name"), L.param("preset")
    if not name or (preset not in TG.PRESETS and preset != "photo"):
        raise RuntimeError(f"name and preset ({', '.join(TG.PRESETS)}, photo) are required")
    dry = bool(L.param("dry_run", False))
    size = int(L.param("size_px", 1024 if preset == "leaf" else 512))
    asg = L.param("assign")
    targets = []
    if asg:
        for o in bpy.context.scene.objects:
            if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, g) for g in asg["objects"]):
                targets.append(o)
        if not targets:
            raise RuntimeError(f"assign: nothing matches {asg['objects']}")
        if asg.get("mapping", "box") == "box":
            lay = asg.get("uv_layer", "UVMap")
            bad = [o.name for o in targets if o.data.uv_layers and not asg.get("overwrite_uv") and (lay in o.data.uv_layers or o.data.uv_layers[0].name != lay)]
            if bad:
                raise RuntimeError(f"assign: {len(bad)} mesh(es) already have UV layers ({bad[:3]}): set overwrite_uv true (a layer named {lay!r} is replaced) or mapping 'keep'")
    if dry:
        L.finish({"dry_run": True, "preset": preset, "size_px": size, "targets": [o.name for o in targets]}, save=False)
        return
    photo_rep = None
    tex_ready = None
    if preset == "photo":
        tex_ready, photo_rep = photo_tile(L.param("args") or {}, size)
    mat, imgs, files, t = make_set(name, preset, size, int(L.param("seed", 1)), L.param("args"), L.param("normal_strength"), L.param("colour"), L.ARGS["out_dir"], tex=tex_ready)
    done = None
    if asg:
        k = 0
        lay = asg.get("uv_layer", "UVMap")
        shared = asg.get("shared", "keep")
        # one entry per MESH datablock: objects that share a mesh (linked copies) stay linked, the picture and UVs are made once
        by_mesh = {}
        for o in targets:
            by_mesh.setdefault(o.data, []).append(o)
        tset = set(targets)
        outside = {m: [u.name for u in bpy.data.objects if u.type == "MESH" and u.data is m and u not in tset] for m in by_mesh}
        if shared == "keep":
            bad = {m.name: v[:3] for m, v in outside.items() if v}
            if bad:
                raise RuntimeError(f"assign: {len(bad)} mesh(es) are also used by objects outside the selection (e.g. {next(iter(bad.items()))}): the material and UVs would change those too. Select them as well, or set assign.shared to 'split' (the selected objects get ONE new mesh each, still linked among themselves) or 'all' (change the shared mesh for every user)")
        elif shared not in ("split", "all"):
            raise RuntimeError("assign.shared: keep | split | all")
        mesh_rows = []
        for m, objs in by_mesh.items():
            use = m
            if shared == "split" and outside[m]:
                use = m.copy()
                for o in objs:
                    o.data = use
            scs = [tuple(round(x, 4) for x in o.matrix_world.to_scale()) for o in objs]
            ref = objs[0]
            if asg.get("mapping", "box") == "box":
                k += box_uv(ref, float(asg.get("tile_m", 0.5)), lay)
            use.materials.clear()
            use.materials.append(mat)
            horiz = [max(abs(q[0]), abs(q[1])) for q in scs]
            mesh_rows.append({"mesh": use.name, "objects": len(objs), "other_users_changed": outside[m][:3] if shared == "all" else [], "split_from": m.name if use is not m else None,
                              "scale_xy_range": [round(min(horiz), 4), round(max(horiz), 4)], "scale_z_range": [round(min(abs(q[2]) for q in scs), 4), round(max(abs(q[2]) for q in scs), 4)]})
        spread = [r for r in mesh_rows if r["scale_xy_range"][1] > 1.01 * r["scale_xy_range"][0] or r["scale_z_range"][1] > 1.01 * r["scale_z_range"][0]]
        done = {"objects": [o.name for o in targets][:60], "objects_total": len(targets), "meshes_unique": len(by_mesh), "shared": shared,
                "instancing_preserved": True,
                "mesh_rows": mesh_rows[:40], "mapping": asg.get("mapping", "box"), "uv_layer": lay, "tile_m": asg.get("tile_m", 0.5), "faces_mapped": k,
                "scale_note": ("UVs are made ONCE per mesh from the FIRST object's scale; linked copies with other scales (%d mesh(es): see scale_xy_range) show the picture at a different size on those copies" % len(spread)) if spread else None}
    pics = {k: {"file": os.path.basename(v), "size": list(imgs[k].size)} for k, v in files.items()}
    L.finish({"material": mat.name, "preset": preset, "size_px": size, "seed": int(L.param("seed", 1)), "file_mean_srgb": [round(float(x), 3) for x in t.get("file_mean_srgb", [])], "mean_colour_srgb": [round(float(x), 3) for x in t["albedo"].reshape(-1, 3).mean(0)],
              "alpha_coverage": round(float(t["alpha"].mean()), 3) if t.get("alpha") is not None else None, "pictures": pics, "assignment": done,
              "photo": photo_rep, "notes": ["images are packed into the file and travel with the export", "no lighting or occlusion is baked: the pictures are generated patterns" if preset != "photo" else ("the picture was only read; the sheet is " + ("a mirrored 2 x 2 copy of the crop" if (photo_rep or {}).get("tile") == "mirror" else "the crop cross-faded with itself shifted by half a picture") + " (seamless); opaque, flat normal map")]}, save=True, files=list(files.values()))


if __name__ == "__main__":
    L.run(main)
