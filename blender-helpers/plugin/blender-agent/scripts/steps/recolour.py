"""recolour — change a colour in a part's ALBEDO picture: turn the exposed blue form into skin, a magenta fringe into brown, or unify the skin tone between parts. Writes a NEW picture (the original image is kept, unused) and points the part's material at it; geometry, UVs and every other map are untouched. Saves a checkpoint (not with dry_run).

Selection (the texels to change), by colour and/or by vertex group:
  from   {"rgb": [r, g, b], "tol": 50}   the texels within that colour distance (sRGB 0-255) of rgb
  group  {"name": "mat_dark", "min_weight": 0.5}   the texels of the faces whose vertices are all in that vertex group; with `from` too, both must hold
  grow_px dilates the selection by that many texels (a fringe: default 0); feather_px softens its edge (default 2)
Target colour:
  to     {"rgb": [r, g, b]}   or   match {"part": "head", "group": "mat_skin"}   the mean albedo colour of that other part's group (from its own picture, through its UVs)
How:
  mode   "shift" (default): move the selection's mean colour to the target, keeping every texel's own variation (detail, shading baked in the picture); "flat": the target colour with `keep_detail` (0..1, default 0.5) of the original lightness variation
  strength 0..1 (default 1): how far each selected texel goes toward the result

params: part (required); image (default the base-colour image) and uv (default active); name the new picture (default "<image>-recoloured"); dry_run (true: nothing is written, the preview pictures are of the result, then it goes back); pictures (default true); res px (default 500).
Returns: image (old / new names, size), selection (texels, share of the picture, mean colour before), target (rgb and where it came from), result (mean colour after the change), texels_changed, pictures: recolour-texture.png (before | selection | after, as the picture sheet) and recolour-{before,after}-{front,back}.png (the part in its texture), notes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import _matsample as MS  # noqa: E402
import kit2_modes as M  # noqa: E402
import uv_common as UC  # noqa: E402
from _handview import render_views  # noqa: E402


def blur(a, r):
    r = int(max(r, 1))
    out = a.astype(np.float32)
    for _ in range(3):
        for ax in (0, 1):
            c = np.cumsum(np.pad(out, [(r + 1, r) if k == ax else (0, 0) for k in range(out.ndim)], mode="edge"), axis=ax)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[ax]), axis=ax)
            lo = np.take(c, np.arange(0, c.shape[ax] - 2 * r - 1), axis=ax)
            out = (hi - lo) / (2 * r + 1)
    return out


def dilate(m, px):
    out = m.copy()
    for _ in range(int(px)):
        n = out.copy()
        n[1:, :] |= out[:-1, :]
        n[:-1, :] |= out[1:, :]
        n[:, 1:] |= out[:, :-1]
        n[:, :-1] |= out[:, 1:]
        out = n
    return out


def tex_pictures(obj, prefix, res):
    scn = bpy.context.scene
    M.workbench(scn, res)
    scn.display.shading.color_type = "TEXTURE"
    P = np.array([(obj.matrix_world @ Vector(c))[:] for c in obj.bound_box])
    ctr = Vector(((P.min(0) + P.max(0)) / 2).tolist())
    ext = float(np.ptp(P, axis=0).max())
    cam_d = bpy.data.cameras.new("rc")
    cam_d.type = "ORTHO"
    cam_d.ortho_scale = ext * 1.3
    cam = bpy.data.objects.new("rc", cam_d)
    scn.collection.objects.link(cam)
    scn.camera = cam
    for o in scn.objects:
        o.hide_render = o is not obj and o is not cam
    files = []
    for nm, d in (("front", Vector((0, -1, 0.15))), ("back", Vector((0, 1, 0.15)))):
        d = d.normalized()
        cam.location = ctr + d * 2.0
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        p = os.path.join(L.ARGS["out_dir"], f"{prefix}-{nm}.png")
        scn.render.filepath = p
        bpy.ops.render.render(write_still=True)
        files.append(p)
    bpy.data.objects.remove(cam, do_unlink=True)
    return files


def main():
    obj = bpy.data.objects.get(L.param("part", ""))
    if obj is None or obj.type != "MESH":
        raise RuntimeError("give `part`: a mesh object")
    me = obj.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None:
        raise RuntimeError("the part has no UV layer")
    im = MS.image_for(obj, "base", L.param("image"))
    W, H = im.size
    px = MS.pixels(im).astype(np.float64)
    rgb = px[..., :3] * 255.0
    frm, grp = L.param("from"), L.param("group")
    if not frm and not grp:
        raise RuntimeError("give `from` (a colour) and/or `group` (a vertex group): what to change")
    sel = np.ones((H, W), bool)
    if frm:
        d = np.linalg.norm(rgb - np.array(frm["rgb"], float), axis=2)
        sel &= d <= float(frm.get("tol", 50))
    if grp:
        g = obj.vertex_groups.get(grp["name"])
        if g is None:
            raise RuntimeError(f"no vertex group {grp['name']}")
        minw = float(grp.get("min_weight", 0.5))
        w = np.zeros(len(me.vertices))
        for v in me.vertices:
            for ge in v.groups:
                if ge.group == g.index:
                    w[v.index] = ge.weight
        me.calc_loop_triangles()
        tv, _, U, tl = UC.uv_arrays(me, uvn)
        keep = (w[tv] >= minw).all(axis=1)
        tid, _b = UC.raster_ids(U[keep], max(W, H))
        gm = (tid >= 0)
        if gm.shape != sel.shape:  # a non-square picture: sample the square mask at the picture's size
            yy = (np.arange(H) * gm.shape[0] / H).astype(int)
            xx = (np.arange(W) * gm.shape[1] / W).astype(int)
            gm = gm[yy][:, xx]
        sel &= gm
    grow = int(L.param("grow_px", 0))
    if grow:
        sel = dilate(sel, grow)
    n_sel = int(sel.sum())
    if n_sel == 0:
        raise RuntimeError("the selection is empty: nothing matches (try a larger tol, or look at the colours with colour_groups)")
    soft = sel.astype(np.float32)
    fe = int(L.param("feather_px", 2))
    if fe > 0:
        soft = np.clip(blur(soft, fe), 0, 1)
        soft = np.where(sel, np.maximum(soft, 0.0) * 0 + 1.0, soft)  # inside stays full; the feather spreads outward only
    strength = float(L.param("strength", 1.0))
    mean_sel = rgb[sel].mean(0)
    # target
    if L.param("to"):
        target, src = np.array(L.param("to")["rgb"], float), "to"
    elif L.param("match"):
        mt = L.param("match")
        o2 = bpy.data.objects.get(mt["part"])
        if o2 is None:
            raise RuntimeError(f"no part {mt['part']}")
        g2 = o2.vertex_groups.get(mt["group"])
        if g2 is None:
            raise RuntimeError(f"{o2.name} has no vertex group {mt['group']}")
        im2 = MS.image_for(o2, "base", mt.get("image"))
        uv2 = o2.data.uv_layers.active.name
        vv = MS.vertex_values(o2, MS.pixels(im2)[..., :3] * 255.0, uv2)
        idx = [v.index for v in o2.data.vertices if any(ge.group == g2.index and ge.weight >= 0.5 for ge in v.groups)]
        if not idx:
            raise RuntimeError("the match group has no vertices")
        target, src = vv[idx].mean(0), f"mean albedo of {o2.name}/{mt['group']} ({len(idx)} vertices)"
    else:
        raise RuntimeError("give `to` {rgb} or `match` {part, group}")
    mode = L.param("mode", "shift")
    new = rgb.copy()
    if mode == "shift":
        res_rgb = rgb + (target - mean_sel)
    elif mode == "flat":
        kd = float(L.param("keep_detail", 0.5))
        lum = rgb @ np.array([0.299, 0.587, 0.114])
        lm = float(lum[sel].mean())
        res_rgb = target[None, None, :] * (1 + kd * (lum / max(lm, 1e-6) - 1))[..., None]
    else:
        raise RuntimeError('mode must be "shift" or "flat"')
    a = (soft * strength)[..., None]
    new = np.clip(rgb * (1 - a) + res_rgb * a, 0, 255)
    changed = int((np.abs(new - rgb).max(axis=2) > 0.5).sum())
    dry = bool(L.param("dry_run", False))
    name = L.param("name", im.name + "-recoloured")
    os.makedirs(L.ARGS["out_dir"], exist_ok=True)
    files = []
    res = int(L.param("res", 500))
    # the sheet: before | selection | after (the picture's own pixels, downscaled)
    def small(a):
        s = max(1, max(H, W) // res)
        return a[::s, ::s]
    sel_img = np.zeros((H, W, 3))
    sel_img[sel] = (1.0, 0.1, 0.8)
    sheet = np.concatenate([small(rgb / 255.0), small(sel_img), small(new / 255.0)], axis=1)
    sp = os.path.join(L.ARGS["out_dir"], "recolour-texture.png")
    UC.save_image(sheet[::-1].astype(np.float32), sp, "sRGB")  # rows were from the bottom
    files.append(sp)
    if L.param("pictures", True):
        files += tex_pictures(obj, "recolour-before", res)
    old_nodes = []
    for m in me.materials:
        if m is not None and m.use_nodes:
            old_nodes += [n for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image == im]
    nim = bpy.data.images.new(name, W, H, alpha=False)
    out_px = np.concatenate([new / 255.0, px[..., 3:4]], axis=2).astype(np.float32)
    nim.pixels.foreach_set(out_px.ravel())
    nim.pack()
    for n in old_nodes:
        n.image = nim
    if L.param("pictures", True):
        files += tex_pictures(obj, "recolour-after", res)
    if dry:
        for n in old_nodes:
            n.image = im
        bpy.data.images.remove(nim)
    L.finish({"part": obj.name, "image": {"old": im.name, "new": None if dry else name, "size": [W, H]}, "selection": {"texels": n_sel, "share_pct": round(n_sel / (W * H) * 100, 2), "mean_rgb_before": [round(float(x), 1) for x in mean_sel]},
              "target": {"rgb": [round(float(x), 1) for x in target], "from": src}, "mode": mode, "strength": strength, "result": {"mean_rgb_after": [round(float(x), 1) for x in new[sel].mean(0)]}, "texels_changed": changed, "dry_run": dry,
              "pictures": [os.path.basename(f) for f in files], "notes": ["the original picture is kept (unused): nothing was overwritten", "the new picture is packed in the checkpoint; export it with a publish or tex_stack export" if not dry else "dry run: the material points at the original again"]}, save=not dry, files=files)


L.run(main)
