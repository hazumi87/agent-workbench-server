"""project_bake — texture the mesh from its orthographic views: register each
view to the mesh, project it from that view's camera, and blend all views into
the mesh's one UV set. Prototype: the views' RGBA cut-outs are the albedo; PBR
maps (per view, same canvas) take the same path.

Blender frame (Z up, character facing -Y; Mesh Studio's glTF spec mapped):
front = camera at -Y, back = +Y, left = +X, right = -X.

How:
  - Cycles bakes (CPU): each texel's world POSITION and UV-island mask once, and
    per view a facing WEIGHT = direct light from a sun along the view (N·L with
    shadows, so surfaces hidden from that camera get nothing from it).
  - Registration per view, PER PART: the body core (everything within 1.3x the
    lower-body half-width) is fitted first — height scale, a lower-body centroid,
    then a search over x/y scale and offset for the best silhouette IoU. The parts
    beyond the core on each side (the arms, in front/back views) then get their own
    horizontal scale, fitted for their own IoU: views draw arms inconsistently.
  - Projection and sampling happen in numpy from the baked positions, with the
    piecewise (core / arm) mapping. A part whose IoU is poor is DOWN-WEIGHTED
    (iou_bad -> 0, iou_good -> 1), not dropped; a view whose core fails iou_min is
    dropped. Fewer than 2 views left: fail.
  - colour = sum(w^p * part_w * alpha * c) / sum(...); unseen texels are filled
    from their UV neighbours. Output out/<name>_baseColor.png in a "Body" material.

params:
  views        {front, left, back, right}: RGBA cut-out paths ({job_dir}/tool-root relative)
  from_library a mesh record id: views from its meta.projection (overrides views)
  res          texture size, default 2048
  sharpness    p, how strongly the best-facing view wins, default 4
  iou_min      body-core IoU a view must reach to be used, default 0.85
  iou_good / iou_bad   part-weight ramp, defaults 0.85 / 0.6
  align_band   height fractions whose silhouette centroid aligns the core, default [0.15, 0.45]
  erode_px     cut-out alpha erosion against white edge fringes, default 3
  min_facing   N·L a view must reach for a texel to count as seen, default 0.35
  mask_side_arms   side views give no colour to the arms or to where the mesh's arm
             footprint (grown by side_arm_dilate_px, default 25) falls in their image —
             front/back colour there instead (default true)
  shadow_soft_deg  sun angle for the facing-weight bake; the penumbra down-weights a
             view around occluders (side views' arms over the torso), default 8
  maps         optional PBR maps per view, same canvas as that view's cut-out:
               {front: {height, roughness, metal, ao}, …}; each a path or a Library id.
               height -> tangent-space normal (OpenGL +Y, normal_strength default 8);
               roughness/metal/ao -> one ORM texture (R=AO, G=roughness white=rough,
               B=metal), wired into the material (glTF occlusion via the
               "glTF Material Output" group). Missing channels: roughness param
               (default 0.7), metal 0, AO 1.
  name         default "body"
"""
import json
import math
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402

# view -> (direction from the character TO the camera, image-right axis); image-up is +Z
VIEWS = {
    "front": (Vector((0, -1, 0)), Vector((1, 0, 0))),
    "back": (Vector((0, 1, 0)), Vector((-1, 0, 0))),
    "left": (Vector((1, 0, 0)), Vector((0, 1, 0))),
    "right": (Vector((-1, 0, 0)), Vector((0, -1, 0))),
}
UP = Vector((0, 0, 1))
ID_RE = __import__("re").compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CHANNELS = ("height", "roughness", "metal", "ao")


def views_from_library(asset_id, library_url):
    """meta.projection {views:{front:{cutout:<url>}, …}} -> local copies in the job folder."""
    with urllib.request.urlopen(f"{library_url}/api/assets/{asset_id}", timeout=30) as r:
        rec = json.loads(r.read())
    meta = rec.get("meta") or {}
    meta = json.loads(meta) if isinstance(meta, str) else meta
    out = {}
    for name, spec in ((meta.get("projection") or {}).get("views") or {}).items():
        url = spec.get("cutout") if isinstance(spec, dict) else None
        if name in VIEWS and url:
            dst = os.path.join(L.ARGS["job_dir"], f"cut_{name}.png")
            with urllib.request.urlopen(url, timeout=60) as r, open(dst, "wb") as f:
                f.write(r.read())
            out[name] = dst
    if len(out) < 2:
        raise RuntimeError(f"{asset_id}: meta.projection has {len(out)} usable views")
    return out


def image_array(img):
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    return buf.reshape(h, w, 4)  # row 0 = bottom


def to_px(u, v, m):
    """World (u along image-right, v up) -> image pixel (x, y from bottom), piecewise in x."""
    t = u - m["cu"]
    a = np.abs(t)
    kxa = np.where(t >= 0, m["kxa_pos"], m["kxa_neg"])
    rel = np.minimum(a, m["b"]) / (m["s0"] * m["kx"]) + np.maximum(a - m["b"], 0) / (m["s0"] * kxa)
    return m["cx"] + m["ox"] + np.sign(t) * rel, m["y0"] + m["oy"] + (v - m["vmin"]) / (m["s0"] * m["ky"])


def register(verts, bvh, alpha, d, right, band):
    """Fit one view to the mesh, per part. Returns (mapping, report)."""
    a = alpha > 0.5
    H, W = a.shape
    ys, xs = np.nonzero(a)
    if len(xs) == 0:
        raise RuntimeError("no alpha — needs an RGBA cut-out")
    y0, y1 = ys.min(), ys.max() + 1
    u = verts @ np.array(right)
    v = verts[:, 2]
    umin, umax, vmin, vmax = u.min(), u.max(), v.min(), v.max()
    lo_b, hi_b = band
    img_band = (ys >= y0 + lo_b * (y1 - y0)) & (ys <= y0 + hi_b * (y1 - y0))
    mesh_band = (v >= vmin + lo_b * (vmax - vmin)) & (v <= vmin + hi_b * (vmax - vmin))
    cu = u[mesh_band].mean() if mesh_band.any() else (umin + umax) / 2
    half = np.abs(u[mesh_band] - cu).max() if mesh_band.any() else (umax - umin) / 2
    m = {"cx": xs[img_band].mean() if img_band.any() else xs.mean(), "cu": cu, "b": 1.3 * half,
         "s0": (vmax - vmin) / (y1 - y0), "y0": y0, "vmin": vmin,
         "kx": 1.0, "ky": 1.0, "ox": 0.0, "oy": 0.0, "kxa_pos": 1.0, "kxa_neg": 1.0}

    # the mesh's silhouette on a world grid, ray-cast once
    n = 140
    du, dv = (umax - umin) * 0.1, (vmax - vmin) * 0.1
    UU, VV = np.meshgrid(umin - du + (umax - umin + 2 * du) * (np.arange(n) + 0.5) / n,
                         vmin - dv + (vmax - vmin + 2 * dv) * (np.arange(n) + 0.5) / n)
    hit = np.array([[bvh.ray_cast(right * float(UU[i, j]) + UP * float(VV[i, j]) + d * 10.0, -d)[0] is not None
                     for j in range(n)] for i in range(n)])
    core = np.abs(UU - cu) <= m["b"]
    parts = {"core": core, "pos": (UU - cu) > m["b"], "neg": (UU - cu) < -m["b"]}

    def iou(mm, region):
        px, py = to_px(UU, VV, mm)
        px, py = px.astype(int), py.astype(int)
        ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
        inside = np.zeros(UU.shape, dtype=bool)
        inside[ok] = a[py[ok], px[ok]]
        h, i = hit & region, inside & region
        union = (h | i).sum()
        return (h & i).sum() / union if union else None

    best = (iou(m, core), dict(m))
    span = y1 - y0
    for kx in np.linspace(0.7, 1.6, 19):
        for ky in (0.96, 0.98, 1.0, 1.02, 1.04):
            for ox in np.linspace(-0.04, 0.04, 9) * span:
                for oy in np.linspace(-0.02, 0.02, 5) * span:
                    mm = {**m, "kx": kx, "ky": ky, "ox": ox, "oy": oy, "kxa_pos": kx, "kxa_neg": kx}
                    val = iou(mm, core)
                    if val is not None and val > best[0]:
                        best = (val, mm)
    m = best[1]
    report = {"core": round(float(best[0]), 3)}
    for side in ("pos", "neg"):  # each arm gets its own horizontal scale
        if not parts[side].any() or not hit[parts[side]].any():
            continue
        best_s = (iou(m, parts[side]) or 0.0, m[f"kxa_{side}"])
        for k in np.linspace(0.5, 2.0, 31):
            val = iou({**m, f"kxa_{side}": k}, parts[side])
            if val is not None and val > best_s[0]:
                best_s = (val, k)
        m[f"kxa_{side}"] = best_s[1]
        report[f"arm_{side}"] = round(float(best_s[0]), 3)
    report["full"] = round(float(iou(m, np.ones_like(core)) or 0.0), 3)
    report["fit"] = {"scale_x": round(float(m["kx"]), 3), "scale_y": round(float(m["ky"]), 3),
                     "arm_scale": [round(float(m["kxa_pos"]), 3), round(float(m["kxa_neg"]), 3)],
                     "offset_px": [round(float(m["ox"]), 1), round(float(m["oy"]), 1)]}
    return m, report


def sample(img_arr, px, py):
    """Bilinear RGBA sample; outside the image -> alpha 0."""
    H, W = img_arr.shape[:2]
    x = np.clip(px - 0.5, 0, W - 1.001)
    y = np.clip(py - 0.5, 0, H - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    c = (img_arr[y0, x0] * (1 - fx) * (1 - fy) + img_arr[y0, x0 + 1] * fx * (1 - fy)
         + img_arr[y0 + 1, x0] * (1 - fx) * fy + img_arr[y0 + 1, x0 + 1] * fx * fy)
    out = (px < 0) | (px >= W) | (py < 0) | (py >= H)
    c[out, 3] = 0
    return c


def solid_alpha(alpha, erode):
    """Cut-outs from white-background art carry a white fringe in their soft edge:
    erode the alpha by `erode` px (3x3 min filter) and ramp it so only solid pixels count."""
    a = alpha.copy()
    for _ in range(erode):
        p = np.pad(a, 1, mode="edge")
        a = np.minimum.reduce([p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
                               for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
    return np.clip((a - 0.6) / 0.4, 0, 1)


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4))


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def dilate_fill(vals, known, iters=64):
    """Grow known texels into unknown ones (unseen island texels + a margin around islands)."""
    res = vals.shape[0]
    known = known.copy()
    for _ in range(iters):
        pad_c = np.pad(vals * known[..., None], ((1, 1), (1, 1), (0, 0)))
        pad_k = np.pad(known.astype(np.float64), 1)
        sc = sum(pad_c[1 + dy:res + 1 + dy, 1 + dx:res + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        kc = sum(pad_k[1 + dy:res + 1 + dy, 1 + dx:res + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        grow = (~known) & (kc > 0)
        if not grow.any():
            break
        vals[grow] = sc[grow] / kc[grow][:, None]
        known |= grow
    return vals


def resolve_map(ref, library_url):
    """A per-view map is a path (tool-root/{job_dir} relative) or a Library asset id."""
    if ID_RE.match(ref):
        dst = os.path.join(L.ARGS["job_dir"], f"map_{ref}.png")
        if not os.path.exists(dst):
            with urllib.request.urlopen(f"{library_url}/api/assets/{ref}/file", timeout=60) as r, open(dst, "wb") as f:
                f.write(r.read())
        return dst
    return L.resolve(ref)


def save_png(name, rgb, colorspace, out_dir):
    res = rgb.shape[0]
    img = bpy.data.images.new(name, res, res, alpha=False)
    img.colorspace_settings.name = colorspace
    rgba = np.ones((res, res, 4), dtype=np.float32)
    rgba[:, :, :3] = rgb
    img.pixels.foreach_set(rgba.ravel())
    path = os.path.join(out_dir, f"{name}.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    img.pack()
    return img, path


def height_to_normal(h, island, strength):
    """Tangent-space normal (OpenGL: +X = +U, +Y = +V) from a UV-space height map;
    gradients only where both neighbours are on the same island texels (else flat)."""
    res = h.shape[0]
    hp = np.pad(h, 1, mode="edge")
    ip = np.pad(island, 1)
    dx = (hp[1:-1, 2:] - hp[1:-1, :-2]) / 2
    dy = (hp[2:, 1:-1] - hp[:-2, 1:-1]) / 2  # row 0 is the bottom: +rows = +V
    okx = ip[1:-1, 2:] & ip[1:-1, :-2]
    oky = ip[2:, 1:-1] & ip[:-2, 1:-1]
    n = np.dstack([-strength * dx * okx, -strength * dy * oky, np.ones((res, res))])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5


def main():
    mesh = L.the_mesh()
    if not mesh.data.uv_layers:
        raise RuntimeError("mesh has no UVs: run uv_unwrap first")
    res = int(L.param("res", 2048))
    p = float(L.param("sharpness", 4))
    iou_min = float(L.param("iou_min", 0.85))
    good, bad_ = float(L.param("iou_good", 0.85)), float(L.param("iou_bad", 0.6))
    band = tuple(L.param("align_band", [0.15, 0.45]))
    erode = int(L.param("erode_px", 3))
    min_facing = float(L.param("min_facing", 0.35))
    mask_side_arms = bool(L.param("mask_side_arms", True))
    name = L.param("name", "body")
    lib_url = L.param("library_url", "http://localhost/asset-management/library")
    maps = {v: {c: resolve_map(ref, lib_url) for c, ref in (chans or {}).items() if c in CHANNELS}
            for v, chans in (L.param("maps") or {}).items()}
    views = L.param("views") or {}
    if L.param("from_library"):
        views = views_from_library(L.param("from_library"), L.param("library_url", "http://localhost/asset-management/library"))

    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = 8
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes["Background"]
    world_strength = bg.inputs[1].default_value
    bg.inputs[1].default_value = 0.0  # no ambient in the weight bakes (restored below)

    verts = np.array([mesh.matrix_world @ v.co for v in mesh.data.vertices], dtype=np.float64)
    bvh = BVHTree.FromPolygons([Vector(v) for v in verts], [tuple(pl.vertices) for pl in mesh.data.polygons])

    # a bake material: its output switches between position, white emission and white diffuse
    target = bpy.data.images.new("bake_target", res, res, alpha=True, float_buffer=True)
    target.colorspace_settings.name = "Non-Color"
    mat = bpy.data.materials.new("ProjBake")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tgt = nt.nodes.new("ShaderNodeTexImage")
    tgt.image = target
    nt.nodes.active = tgt
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    emit = nt.nodes.new("ShaderNodeEmission")
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diff.inputs["Color"].default_value = (1, 1, 1, 1)
    saved = [s.material for s in mesh.material_slots]
    if not mesh.material_slots:
        mesh.data.materials.append(mat)
    for s in mesh.material_slots:
        s.material = mat
    L.activate(mesh)

    def bake_emit(src):
        for lk in list(emit.inputs["Color"].links):
            nt.links.remove(lk)
        if src is None:
            emit.inputs["Color"].default_value = (1, 1, 1, 1)
        else:
            nt.links.new(src, emit.inputs["Color"])
        nt.links.new(emit.outputs[0], out.inputs["Surface"])
        bpy.ops.object.bake(type="EMIT", margin=0, use_clear=True)
        return image_array(target)

    island = bake_emit(None)[:, :, 0] > 0.5
    pos = bake_emit(geo.outputs["Position"])[:, :, :3]
    idx = np.nonzero(island)
    P = pos[idx]  # world positions of island texels

    sun = bpy.data.objects.new("ProjSun", bpy.data.lights.new("ProjSun", "SUN"))
    sun.data.energy = 1.0
    # a soft sun: the shadow of an occluder (a side view's arm in front of the torso)
    # gets a penumbra, which lowers that view's weight in the ring around it, where
    # a drawn arm that is bigger than the mesh's would otherwise paint the torso
    sun.data.angle = math.radians(float(L.param("shadow_soft_deg", 8)))
    scn.collection.objects.link(sun)
    nt.links.new(diff.outputs[0], out.inputs["Surface"])

    # arms in world space: beyond 1.3x the lower-body half-width in X (the front
    # view's core). Side views are masked off them: a side view's near
    # arm points at the camera and its drawing can't match the mesh's arm.
    zl = verts[:, 2].min() + band[0] * np.ptp(verts[:, 2])
    zh = verts[:, 2].min() + band[1] * np.ptp(verts[:, 2])
    lower = verts[(verts[:, 2] >= zl) & (verts[:, 2] <= zh)]
    cx_w = lower[:, 0].mean() if len(lower) else 0.0
    b_w = 1.3 * np.abs(lower[:, 0] - cx_w).max() if len(lower) else np.inf
    arm_verts = verts[np.abs(verts[:, 0] - cx_w) > b_w]
    texel_is_arm = np.abs(P[:, 0] - cx_w) > b_w
    dilate = int(L.param("side_arm_dilate_px", 25))

    acc = np.zeros((len(P), 3))
    wsum = np.zeros(len(P))
    best_facing = np.zeros(len(P))
    ch_acc = {c: np.zeros(len(P)) for c in CHANNELS}
    ch_w = {c: np.zeros(len(P)) for c in CHANNELS}
    fits = {}
    for vname, (d, right) in VIEWS.items():
        if vname not in views:
            continue
        img = bpy.data.images.load(L.resolve(views[vname]))
        arr = image_array(img)
        m, rep = register(verts, bvh, arr[:, :, 3], d, right, band)
        arr[:, :, 3] = solid_alpha(arr[:, :, 3], erode)
        rep["used"] = rep["core"] >= iou_min
        fits[vname] = rep
        if not rep["used"]:  # the body doesn't fit: this view would smear everything
            continue
        sun.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, margin=0, use_clear=True)
        light = image_array(target)[:, :, 0][idx]
        u, v = P @ np.array(right), P[:, 2]
        px, py = to_px(u, v, m)
        c = sample(arr, px, py)
        # per-part weight: a part that registers poorly contributes less
        t = u - m["cu"]
        part_iou = np.where(np.abs(t) <= m["b"], rep["core"],
                            np.where(t > 0, rep.get("arm_pos", rep["core"]), rep.get("arm_neg", rep["core"])))
        part_w = np.clip((part_iou - bad_) / max(good - bad_, 1e-6), 0, 1)
        facing = np.clip(light / max(light.max(), 1e-6), 0, 1)
        if vname in ("left", "right") and mask_side_arms and len(arm_verts):
            # the mesh's arm footprint in this side view, grown by `dilate` px (the
            # drawn arm covers more than the mesh's): no side colour inside it
            H, Wd = arr.shape[:2]
            ax, ay = to_px(arm_verts @ np.array(right), arm_verts[:, 2], m)
            foot = np.zeros((H, Wd), dtype=bool)
            ok_ = (ax >= 0) & (ax < Wd) & (ay >= 0) & (ay < H)
            foot[ay[ok_].astype(int), ax[ok_].astype(int)] = True
            for _ in range(dilate):
                q = np.pad(foot, 1)
                foot = q[1:-1, 1:-1] | q[:-2, 1:-1] | q[2:, 1:-1] | q[1:-1, :-2] | q[1:-1, 2:]
            tx, ty = np.clip(px.astype(int), 0, Wd - 1), np.clip(py.astype(int), 0, H - 1)
            part_w = part_w * ~(foot[ty, tx] | texel_is_arm)
            rep["arm_masked_pct"] = round(100 * float((foot[ty, tx] | texel_is_arm).mean()), 1)
        w = np.power(facing, p) * np.clip(c[:, 3], 0, 1) * part_w
        best_facing = np.maximum(best_facing, facing * (c[:, 3] > 0.5) * (part_w > 0))
        acc += w[:, None] * srgb_to_lin(c[:, :3])
        wsum += w
        for ch, mpath in maps.get(vname, {}).items():  # PBR maps: same canvas, same mapping, same weights
            mimg = bpy.data.images.load(mpath)
            mimg.colorspace_settings.name = "Non-Color"  # 8-bit linear greyscale
            val = sample(image_array(mimg), px, py)[:, 0]
            ch_acc[ch] += w * val
            ch_w[ch] += w
    bpy.data.objects.remove(sun, do_unlink=True)
    bg.inputs[1].default_value = world_strength or 1.0
    used = [k for k, r in fits.items() if r["used"]]

    # a texel is SEEN only if some view faces it reasonably; surfaces every view
    # grazes (tops of arms and shoulders) are filled from neighbours instead of
    # from stretched edge-on projections
    seen = (wsum > 1e-6) & (best_facing >= min_facing)
    known = np.zeros((res, res), dtype=bool)
    known[idx[0][seen], idx[1][seen]] = True
    color = np.zeros((res, res, 3))
    color[idx[0][seen], idx[1][seen]] = acc[seen] / wsum[seen][:, None]
    color = dilate_fill(color, known)
    out_dir = L.ARGS["out_dir"]
    outimg, path = save_png(f"{name}_baseColor", lin_to_srgb(color), "sRGB", out_dir)
    files = [path]

    grey = {}
    for ch in CHANNELS:
        if not ch_w[ch].any():
            continue
        g = np.zeros((res, res, 1))
        ok_ch = seen & (ch_w[ch] > 1e-6)
        g[idx[0][ok_ch], idx[1][ok_ch], 0] = ch_acc[ch][ok_ch] / ch_w[ch][ok_ch]
        kn = np.zeros((res, res), dtype=bool)
        kn[idx[0][ok_ch], idx[1][ok_ch]] = True
        grey[ch] = dilate_fill(g, kn)[:, :, 0]
    normal_img = orm_img = None
    if "height" in grey:
        nrm = height_to_normal(grey["height"], island, float(L.param("normal_strength", 8.0)))
        normal_img, npath = save_png(f"{name}_normal", nrm, "Non-Color", out_dir)
        files.append(npath)
    if {"roughness", "metal", "ao"} & set(grey):
        orm = np.dstack([grey.get("ao", np.ones((res, res))),
                         grey.get("roughness", np.full((res, res), float(L.param("roughness", 0.7)))),
                         grey.get("metal", np.zeros((res, res)))])
        orm_img, opath = save_png(f"{name}_orm", orm, "Non-Color", out_dir)
        files.append(opath)

    body = bpy.data.materials.get("Body") or bpy.data.materials.new("Body")
    body.use_nodes = True
    bnt = body.node_tree
    bsdf = bnt.nodes.get("Principled BSDF")
    tex = bnt.nodes.new("ShaderNodeTexImage")
    tex.image = outimg
    bnt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = float(L.param("roughness", 0.7))
    if normal_img:
        nt_ = bnt.nodes.new("ShaderNodeTexImage")
        nt_.image = normal_img
        nm = bnt.nodes.new("ShaderNodeNormalMap")
        bnt.links.new(nt_.outputs["Color"], nm.inputs["Color"])
        bnt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if orm_img:
        ot = bnt.nodes.new("ShaderNodeTexImage")
        ot.image = orm_img
        sep = bnt.nodes.new("ShaderNodeSeparateColor")
        bnt.links.new(ot.outputs["Color"], sep.inputs["Color"])
        bnt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        bnt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        if "ao" in grey:  # glTF occlusion: the exporter reads the "glTF Material Output" group
            grp = bpy.data.node_groups.get("glTF Material Output")
            if grp is None:
                grp = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
                grp.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
            gn = bnt.nodes.new("ShaderNodeGroup")
            gn.node_tree = grp
            bnt.links.new(sep.outputs["Red"], gn.inputs["Occlusion"])
    for s, m0 in zip(mesh.material_slots, saved or [None]):
        s.material = body if (m0 is None or m0.name == "Skin") else m0
    bpy.data.materials.remove(mat)
    bpy.data.images.remove(target)

    n_island = max(len(P), 1)
    summary = {"texture": os.path.basename(path), "maps": sorted(grey) + (["normal"] if normal_img else []),
               "res": res, "views": fits, "used_views": used,
               "dropped_views": [k for k in fits if k not in used],
               "seen_pct": round(100 * float(seen.sum()) / n_island, 1)}
    ok = len(used) >= 2
    L.finish(summary, save=ok, ok=ok,
             error=None if ok else f"fewer than 2 views register above iou_min {iou_min}: {fits}", files=files)


L.run(main)
