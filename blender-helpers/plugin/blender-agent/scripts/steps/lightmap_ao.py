"""lightmap_ao — bake ONE ambient-occlusion map for the receivers that already have a LightmapUV (from lightmap_bake), on the SAME atlas, with the SAME texel coverage and padding. Changes nothing in the scene and saves no checkpoint (run it on a COPY anyway). It never touches the direct-response maps.

Value: linear scalar per texel, 0 = fully occluded, 1 = open: Cycles' ambient-occlusion bake (cosine-weighted hemisphere above the surface, the fraction of rays that travel `distance_m` without hitting anything). Receivers are baked with an opaque white material (like lightmap_bake: their own alpha is ignored); every other render-visible mesh occludes with its own material (a cut-out material's transparent texels let rays through: measure the alpha behaviour with the fixture in docs before relying on it); meshes matching `exclude_casters` (default the bulb diffuser shells) are hidden from rendering for the bake and put back.
params:
  receivers  name globs of the receivers (the SAME list as the direct bake)   [required]; each must already hold a LightmapUV layer and a single-user mesh (nothing is unwrapped here)
  name       output stem (default "ao")
  atlas_px   must equal the direct bake's atlas (default 1024)
  distance_m the AO ray length in metres (default 1.0): geometry farther than this does not occlude
  samples    default 128
  dilate_px  padding like the direct bake (default 2): texels next to an island are filled by edge dilation, label 2
  exclude_casters  globs hidden for the bake (default ["bulb_*.diffuser"])
  mask       optional path of the direct bake's .mask.u8: the labels are compared and the number of differing texels reported
  format     "f16" (default: <name>.ao.bin) | "u8" (<name>.ao.u8: ONE plane of width*height bytes, 255 = open, 0 = fully occluded, linear, row 0 = glTF v 0, mask-0 texels 255, padding texels edge-dilated: the target runtime ao descriptor) | "both"
  tie_rule   "inclusive" (default) | "top_left_b" | "top_left_b_f32": MUST equal the direct bake's tie_rule, or texel centres exactly on a triangle edge are labelled differently (mask comparison fails)
  padding    "mean" (default: each padding ring texel = the mean of its covered neighbours, like the direct bake) | "nearest" (edge copy: each ring texel takes ONE covered neighbour's value, 4-neighbours first, so it always equals a real covered value and islands are not blended); labels, mask1 and mask0=255 are identical in both
  require_exact_mask  true: with `mask`, refuse (no files written) when ANY texel label differs from the direct bake's mask (default false: only counted)
Writes out/lightmaps/<name>.ao.bin (float16 little-endian, width x height, row-major, ROW 0 = glTF v 0 = the flip of Blender's row 0, like the direct pack), <name>.ao.json (metadata: dimensions, dtype, byte order, row origin, semantics, distance, samples, uv_channel TEXCOORD_1, receivers, bytes, sha256, statistics, hidden casters, mask comparison) and <name>-ao.png (picture). Non-receiver texels hold 1.0 (use the mask: 0 = not a receiver).
"""
import fnmatch
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def dilate_nearest(val, cov, n):
    """EDGE-COPY padding: each ring texel takes the value of ONE covered neighbour (4-neighbours first, left/right/up/down, then diagonals), never an average, so a padding texel always equals a real covered value and two islands are never blended. Border-safe (no wrap). Covered texels are never touched."""
    h, w = val.shape
    v = val.copy()
    c = cov.copy()
    order = ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1))
    for _ in range(n):
        pv = np.pad(v, 1)
        pc = np.pad(c, 1)
        new = np.zeros(c.shape, bool)
        out = v.copy()
        for dy, dx in order:
            sv = pv[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            sc = pc[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            take = (~c) & (~new) & sc
            out = np.where(take, sv, out)
            new |= take
        v = out
        c = c | new
    return v, c


def main():
    atlas = int(L.param("atlas_px", 1024))
    name = L.param("name", "ao")
    dist = float(L.param("distance_m", 1.0))
    samples = int(L.param("samples", 128))
    dil = int(L.param("dilate_px", 2))
    fmt = L.param("format", "f16")
    if fmt not in ("f16", "u8", "both"):
        raise RuntimeError('format must be "f16", "u8" or "both"')
    exact = bool(L.param("require_exact_mask", False))
    pad_mode = L.param("padding", "mean")
    if pad_mode not in ("mean", "nearest"):
        raise RuntimeError('padding must be "mean" (default, the direct bake\'s ring average) or "nearest" (edge copy)')
    excl = L.param("exclude_casters", ["bulb_*.diffuser"])
    if not L.param("receivers"):
        raise RuntimeError("receivers: give the same globs as the direct bake")
    recv = LB.pick(L.param("receivers"), {"MESH"})
    for o in recv:
        if LB.LM not in o.data.uv_layers:
            raise RuntimeError(f"{o.name}: no {LB.LM} layer (run the direct bake first); nothing is unwrapped here")
        if o.data.users > 1:
            raise RuntimeError(f"{o.name}: its mesh is shared with another object; make it single-user first")
    scn = bpy.context.scene
    tie = L.param("tie_rule", "inclusive")
    if tie not in ("inclusive", "top_left_b", "top_left_b_f32"):
        raise RuntimeError('tie_rule must be "inclusive", "top_left_b" or "top_left_b_f32" (the same value the direct bake used)')
    LB.TIE_RULE[0] = tie
    cover, pos, nrm, owner, stats, empty = LB.raster(recv, atlas)
    covered = cover > 0
    # --- bake
    img = bpy.data.images.new("lm_ao", atlas, atlas, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    tmp = bpy.data.materials.new("lm_ao_white")
    tmp.use_nodes = True
    nt = tmp.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    dif = nt.nodes.new("ShaderNodeBsdfDiffuse")
    outn = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(dif.outputs["BSDF"], outn.inputs["Surface"])
    tex.select = True
    nt.nodes.active = tex
    undo = []
    for o in recv:
        if not o.material_slots:
            o.data.materials.append(tmp)
            undo.append((o, None))
        else:
            undo.append((o, [sl.material for sl in o.material_slots]))
            for sl in o.material_slots:
                sl.material = tmp
    hidden = [o for o in scn.objects if o.type == "MESH" and o not in recv and not o.hide_render and any(fnmatch.fnmatchcase(o.name, g) for g in excl)]
    for o in hidden:
        o.hide_render = True
    ren0 = {}
    for o in recv:
        lay = o.data.uv_layers[LB.LM]
        ren0[o] = next((u for u in o.data.uv_layers if u.active_render), None)
        lay.active_render = True
        o.data.uv_layers.active = lay
    w = scn.world or bpy.data.worlds.new("lm_ao_world")
    scn.world = w
    d0 = w.light_settings.distance
    w.light_settings.distance = dist
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = False
    bpy.ops.object.select_all(action="DESELECT")
    for o in recv:
        o.select_set(True)
    bpy.context.view_layer.objects.active = recv[0]
    try:
        bpy.ops.object.bake(type="AO", margin=0, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES")
    finally:
        w.light_settings.distance = d0
        for o in hidden:
            o.hide_render = False
        for o, lay0 in ren0.items():
            if lay0 is not None:
                lay0.active_render = True
        for o, mats in undo:
            if mats is None:
                o.data.materials.clear()
            else:
                for sl, m in zip(o.material_slots, mats):
                    sl.material = m
        bpy.data.materials.remove(tmp)
    px = np.empty(atlas * atlas * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    ao = np.clip(px.reshape(atlas, atlas, 4)[..., 0].astype(np.float64), 0.0, 1.0)
    bpy.data.images.remove(img)
    # --- same coverage/padding as the direct bake: covered texels keep their value, `dil` rings of padding by edge dilation, the rest 1.0
    if pad_mode == "nearest":
        v, c = dilate_nearest(np.where(covered, ao, 0.0), covered, dil)
    else:
        v, c = LB.dilate(np.where(covered, ao, 0.0), covered, dil)
    full = np.where(c, v, 1.0)
    labels = np.where(covered, 1, np.where(c, 2, 0)).astype(np.uint8)
    d = os.path.join(L.ARGS["out_dir"], "lightmaps")
    os.makedirs(d, exist_ok=True)
    cv = ao[covered]
    mask_cmp = None
    mp = L.param("mask")
    if mp:
        m = np.fromfile(L.resolve(mp), dtype=np.uint8)
        if m.size == atlas * atlas:
            m = m.reshape(atlas, atlas)
            mask_cmp = {"file": os.path.basename(mp), "texels_differing": int((m != np.flipud(labels)).sum()), "label1_in_mask": int((m == 1).sum()), "label1_here": int((labels == 1).sum()),
                        "label2_in_mask": int((m == 2).sum()), "label2_here": int((labels == 2).sum()), "exact": bool((m == np.flipud(labels)).all())}
        else:
            mask_cmp = {"error": f"mask size {m.size} is not {atlas}x{atlas}"}
    if exact and not (mask_cmp and mask_cmp.get("exact")):
        raise RuntimeError(f"require_exact_mask: the AO coverage does not match the direct bake's mask ({mask_cmp}); nothing was written")
    binp = u8p = None
    sha = u8sha = None
    if fmt in ("f16", "both"):
        binp = os.path.join(d, name + ".ao.bin")
        np.flipud(full).astype("<f2").tofile(binp)
        sha = hashlib.sha256(open(binp, "rb").read()).hexdigest()
    u8desc = None
    if fmt in ("u8", "both"):
        u8 = np.flipud(np.rint(np.clip(full, 0.0, 1.0) * 255.0)).astype(np.uint8)
        lab_f = np.flipud(labels)
        u8 = np.where(lab_f == 0, 255, u8).astype(np.uint8)  # mask-0 texels are NOT receivers: 255 (the loader rejects anything else)
        u8p = os.path.join(d, name + ".ao.u8")
        u8.tofile(u8p)
        u8sha = hashlib.sha256(open(u8p, "rb").read()).hexdigest()
        u8desc = {"name": os.path.basename(u8p), "bytes": os.path.getsize(u8p), "sha256": u8sha, "format": "u8", "channels": 1, "width": atlas, "height": atlas, "encoding": "linear", "uv": "TEXCOORD_1",
                  "note": "strength_default and model_sha256 (= the final GLB's sha256) are added by the manifest writer; row 0 = glTF v 0", "mask0_texels": int((labels == 0).sum()), "mask0_texels_not_255": int(((lab_f == 0) & (u8 != 255)).sum()),
                  "padding_texels_label2": int((labels == 2).sum())}
    meta = {"version": 1, "kind": "ambient_occlusion", "width": atlas, "height": atlas, "dtype": ("float16" if binp else "uint8"), "byte_order": "little", "layout": "row-major, one channel", "row_origin": "gltf_v0",
            "semantics": "linear scalar, 0 = fully occluded, 1 = open; cosine-weighted hemisphere fraction of rays unoccluded within distance_m", "distance_m": dist, "samples": samples, "uv_channel": "TEXCOORD_1",
            "padding_texels": dil, "non_receiver_value": 1.0, "receivers": [o.name for o in recv], "bin": ({"name": os.path.basename(binp), "bytes": os.path.getsize(binp), "sha256": sha} if binp else None), "ao_u8": u8desc,
            "casters": {"receivers": "baked with an opaque white material (own alpha ignored)", "others": "occlude with their own materials", "hidden_for_bake": sorted(o.name for o in hidden)},
            "statistics_over_covered_texels": {"texels": int(covered.sum()), "min": round(float(cv.min()), 4), "mean": round(float(cv.mean()), 4), "p10_p50_p90": [round(float(np.percentile(cv, q)), 4) for q in (10, 50, 90)],
                                               "share_below_half_percent": round(float((cv < 0.5).mean()) * 100, 2)}, "mask_comparison": mask_cmp}
    with open(os.path.join(d, name + ".ao.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    pic = bpy.data.images.new("lm_ao_pic", atlas, atlas, alpha=False)
    rgba = np.repeat(full[..., None], 3, axis=2)
    pic.pixels.foreach_set(np.concatenate([rgba, np.ones((atlas, atlas, 1))], axis=2).ravel().astype(np.float32))
    pp = os.path.join(L.ARGS["out_dir"], name + "-ao.png")
    pic.filepath_raw = pp
    pic.file_format = "PNG"
    pic.save()
    bpy.data.images.remove(pic)
    L.finish({"name": name, "atlas_px": atlas, "distance_m": dist, "samples": samples, "covered_texels": int(covered.sum()), "format": fmt, "bin": meta["bin"], "ao_u8": u8desc, "statistics": meta["statistics_over_covered_texels"], "mask_comparison": mask_cmp,
              "hidden_casters": meta["casters"]["hidden_for_bake"]}, save=False, files={**({"bin": binp} if binp else {}), **({"u8": u8p} if u8p else {}), "json": os.path.join(d, name + ".ao.json"), "picture": pp})


L.run(main)
