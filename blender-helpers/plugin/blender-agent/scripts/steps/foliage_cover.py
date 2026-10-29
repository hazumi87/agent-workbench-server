"""foliage_cover — dress an EXISTING coarse foliage shape (a faceted hedge cluster, a bush blob, a shrub) with many small leaf-cluster cards so it reads as leafy with an irregular edge, while its boundary, height and placement stay exactly the existing shape's. Lightweight: every card is one quad (2 triangles), all in ONE mesh sharing ONE material with a generated glossy-leaf atlas (alpha cut-out, CLIP). Saves a checkpoint (not with dry_run). The covered objects are never changed (archive or darken them yourself: scene_archive, material_solid).
How: points are sampled over the covered surface in proportion to its area (undersides and anything below `min_z` skipped), each gets a card standing on the surface (normal = the surface normal tilted by up to `tilt_deg` at random, random roll, lifted outward by a random `outward_m`) so cards overlap in layers and break the silhouette; each card shows one of four leaf-cluster crops of the atlas.
params:
  name        name of the new object `<name>` (and its material `<name>-leaf`)   [required]
  cover       names or globs of the shapes to dress   [required]
  density     cards per m2 of covered surface (default 140: enough that the card gaps do not show the shape underneath; the report gives the triangles; about 2 triangles per card)
  size_m      [min, max] card size in metres (default [0.18, 0.34]); the card is square
  outward_m   [min, max] how far a card is lifted off the surface (default [0.0, 0.04])
  tilt_deg    random tilt of a card away from the surface normal (default 35)
  min_z       ignore surface below this world height (default: the lowest point of the covered shapes + 0.15 m, so nothing hangs on the ground)
  include_undersides  false (default: surface facing down, normal z <= -0.35, is skipped: right for a hedge seen from above or the side). true: dress it too, for a tall canopy seen from BELOW (a site camera under a tree crown shows bare patches otherwise); the trunk stays excluded by `min_z`
  min_normal_z  default -0.35: skip faces whose normal z is at or below this (-1 skips nothing but exactly vertical-down faces, -0.8 keeps all but the flattest undersides); ignored when include_undersides is true
  max_cards   cap (default 6000)
  seed        default 1
  leaf        {"image": name of a packed image in the file OR a file path: PHOTO route, no generation (see below), "size_px": 1024 (int), "leaves": 90 (int, leaves per atlas), "colour": [r, g, b] (0..1 as seen), "gloss": 0.32 (float: roughness of the leaf, lower = glossier), "length": [0.09, 0.16] (leaf length as a fraction of the picture: a [min, max] list, or ONE number = typical length, +-20 %), "kind": "broad" (default, oval leaves) | "conifer" (flat frond sprays for thuja/cypress walls: defaults leaves 8, length [0.40, 0.46], colour [0.12,0.30,0.10] dark inside, "colour2" [0.30,0.46,0.16] the lighter tips, gloss 0.7; use size_m about [0.25, 0.45], density about 90 and tilt_deg 15-20)}: the atlas (texture_make's `leaf` preset); the atlas is a 2 x 2 sheet of leaf clusters, so a card shows about a quarter of it
  dry_run     true: count the cards and triangles, create nothing
PHOTO route (`leaf.image`): the atlas is cut from an existing picture (a cut-out photo of a tree on a transparent or white background): each of the 4 cells shows one blob-shaped patch of it with a ragged border and alpha 0 outside; the source colours are kept exactly (a little darkening towards the cut edge). Keys: "image", "rotate_cw_deg" 0 (default: all coordinates are in the RAW stored pixels, Blender ignores EXIF orientation) | 90 | 180 | 270 (turn the picture clockwise first, so a phone photo with EXIF orientation 6 needs 90, 3 needs 180, 8 needs 270; the region is then in the UPRIGHT picture), "region" [x0, y0, x1, y1] fractions from the TOP-LEFT of the (rotated) picture where patches may be cut (default [0.2, 0.15, 0.8, 0.85]: keep inside the tree, away from its outline), "gap" {"dark_percent": 0 (cut the darkest N % of each patch: shadow between leaves becomes a hole; try 20-35), "sky": false (true: bluish bright pixels = sky become holes), "min_px": 2 (remove specks / slivers smaller than this many px: holes and leaves are clusters, not noise)} (optional: the alpha follows the real leaf clusters with gaps cut through, not just the blob outline; the report lists each patch as [x, y, source opacity, share opaque]), "at" [[cx, cy], ...] (optional: the patch CENTRES, fractions from the top-left of the rotated picture, one per cell in order, cycling; overrides the random choice inside `region`: use it to pick leafy areas of a photo that also shows pots, ground or sky), "patch" 0.28 (patch width as a fraction of the picture width), "feather" 0.22 (how far the darkening / border zone reaches in), "ragged" 0.25 (border irregularity), "roughness" 0.8, "relief" 0 (default: a FLAT normal map, so the photo gives colour only; a number such as 0.5-1 turns the photo's brightness into relief, which makes every contrast edge a raised shard), `size_px`, `kind`, `leaves`, `colour`, `length` are ignored. A patch must be mostly opaque in the source (the best of 40 tries is used; the report lists each patch's position and opacity). Limits: patches are copies of the photo (block-averaged when the source is large, nearest-sampled when small: a 512 px source cut at 0.28 width gives ~143 px patches shown in 512 px cells = visibly soft: use a larger source or a smaller `size_px`); only the 4 patches of the sheet are used, so repeats show on a big tree (vary `seed` and make a second cover with another seed for a second set); the shading of the photo (its light and dark side) is baked in the patches; no lighting is generated.
Returns: cards, triangles, covered surface area (m2), the new object's bounding box against the covered shapes', the material and atlas, notes (what was skipped).
"""
import fnmatch
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import texture_make as TM  # noqa: E402


def _morph(m, n, erode):
    out = m.copy()
    for dy in range(-n, n + 1):
        for dx in range(-n, n + 1):
            sh = np.roll(np.roll(m, dy, 0), dx, 1)
            out = (out & sh) if erode else (out | sh)
    return out


def photo_atlas(spec, size, seed, cells=2):  # region/patch coordinates refer to the picture AFTER rotate_cw_deg
    """a cells x cells sheet of PHOTO patches cropped from an existing image (no generation): each cell shows a blob-shaped canopy patch with a ragged, faded border and alpha 0 outside it"""
    src = spec["image"]
    img = bpy.data.images.get(src)
    if img is None:
        import os as _os
        if not _os.path.isfile(src):
            raise RuntimeError(f"leaf.image: no image named {src!r} in the file and no such file")
        img = bpy.data.images.load(src, check_existing=True)
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)[::-1]   # row 0 = top
    if img.is_float:
        px = px.copy()
        px[..., :3] = np.where(px[..., :3] <= 0.0031308, px[..., :3] * 12.92, 1.055 * np.power(np.maximum(px[..., :3], 0), 1 / 2.4) - 0.055)
    rot = int(spec.get("rotate_cw_deg", 0)) % 360   # Blender loads the RAW stored pixels and ignores the EXIF orientation: 0 = region/patch refer to the raw pixels; 90 = turn the picture 90 deg clockwise first (EXIF orientation 6, a phone portrait shot), 180 (EXIF 3), 270 (EXIF 8)
    if rot not in (0, 90, 180, 270):
        raise RuntimeError("leaf.rotate_cw_deg: 0, 90, 180 or 270")
    if rot:
        px = np.ascontiguousarray(np.rot90(px, k=-(rot // 90)))
        H, W = px.shape[:2]
    reg = spec.get("region") or [0.2, 0.15, 0.8, 0.85]   # fractions of the picture from the top-left: where canopy patches may be cut (inside the tree, away from its outline)
    pw = float(spec.get("patch", 0.28))                  # patch width as a fraction of the picture width
    feather = float(spec.get("feather", 0.22))
    ragged = float(spec.get("ragged", 0.25))
    rng = np.random.default_rng(seed)
    S = size
    cs = S // cells
    pp = max(8, int(pw * W))
    alb, alpha = np.zeros((S, S, 3)), np.zeros((S, S))
    yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float64)
    rr = np.sqrt(((xx - cs / 2 + 0.5) / (cs / 2)) ** 2 + ((yy - cs / 2 + 0.5) / (cs / 2)) ** 2)
    used = []
    for cell in range(cells * cells):
        best = None
        at = spec.get("at")
        if at:   # explicit patch centres (fractions from the top-left of the rotated picture), used in order, cycling
            cxf, cyf = at[cell % len(at)]
            x0 = int(min(max(cxf * W - pp / 2, 0), W - pp))
            y0 = int(min(max(cyf * H - pp / 2, 0), H - pp))
            crop = px[y0:y0 + pp, x0:x0 + pp]
            best = (float(crop[..., 3].mean()), x0, y0, crop)
        for _try in range(0 if at else 40):
            x0 = int(rng.uniform(reg[0] * W, max(reg[2] * W - pp, reg[0] * W + 1)))
            y0 = int(rng.uniform(reg[1] * H, max(reg[3] * H - pp, reg[1] * H + 1)))
            x0, y0 = min(x0, W - pp), min(y0, H - pp)
            crop = px[y0:y0 + pp, x0:x0 + pp]
            cov = float(crop[..., 3].mean())
            if best is None or cov > best[0]:
                best = (cov, x0, y0, crop)
            if cov > 0.97:
                break
        cov, x0, y0, crop = best
        used.append([round(x0 / W, 3), round(y0 / H, 3), round(cov, 2)])
        _used_idx = len(used) - 1
        k = pp // cs
        if k >= 2:   # a big source (a phone photo): average k x k blocks, no aliasing
            c = crop[:cs * k, :cs * k].reshape(cs, k, cs, k, 4).mean(axis=(1, 3))
            if k * cs < pp:
                ii = (np.arange(cs) * (cs * k) / cs).astype(int)
        else:
            ii = (np.arange(cs) * pp / cs).astype(int)
            c = crop[ii][:, ii]   # a small source: nearest-neighbour up-sample to the cell size
        n = _noise_field(cs, rng)
        a = ((1 - rr) + ragged * (n - 0.5) * 2 > feather * 0.35) & (rr < 1.0)
        a = a & (c[..., 3] > 0.5)
        gp = spec.get("gap") or {}
        if gp:   # cut GAPS through the patch so the alpha follows the actual leaf / frond clusters
            lum = 0.299 * c[..., 0] + 0.587 * c[..., 1] + 0.114 * c[..., 2]
            keep = np.ones(a.shape, dtype=bool)
            dp = float(gp.get("dark_percent", 0))
            if dp > 0 and a.any():
                keep &= lum > np.percentile(lum[a], dp)   # the darkest dp % of the patch (deep shadow between leaves) becomes a hole
            if gp.get("sky"):
                sky = (c[..., 2] > c[..., 1] * 0.97) & (lum > 0.3)   # bluish and bright = sky seen through the hedge
                keep &= ~_morph(sky, 2, False)
            mp = int(gp.get("min_px", 2))
            if mp > 0:   # remove specks and thin slivers (open), so holes and leaves are clusters, not noise
                keep = _morph(_morph(keep, mp, True), mp, False)
            a = a & keep
        edge = np.clip((1 - rr) / max(feather, 1e-3), 0, 1)
        rgb = c[..., :3] * (0.78 + 0.22 * edge[..., None])   # a little darker towards the cut edge, so the border blends into the mass behind it
        ox, oy = (cell % cells) * cs, (cell // cells) * cs
        used[_used_idx].append(round(float(a.mean()), 2))   # last number: the share of the cell that is opaque after the border and the gaps
        alb[S - oy - cs:S - oy, ox:ox + cs] = rgb[::-1]
        alpha[S - oy - cs:S - oy, ox:ox + cs] = a[::-1]
    lum = alb.mean(2)
    bgc = alb[alpha > 0].mean(0) * 0.6 if (alpha > 0).any() else np.array([0.1, 0.2, 0.1])
    alb = np.where(alpha[..., None] > 0, alb, bgc[None, None, :])
    rel = float(spec.get("relief", 0.0))   # 0 = FLAT normal map: the photo supplies colour only, no relief from its contrast edges
    height = np.clip(0.5 + rel * (lum - lum.mean()), 0, 1)
    return {"albedo": np.clip(alb, 0, 1), "height": height, "roughness": np.full((S, S), float(spec.get("roughness", 0.8))), "alpha": alpha, "normal_strength": 0.5}, used


def _noise_field(n, rng):
    f = np.fft.fft2(rng.standard_normal((n, n)))
    ky, kx = np.meshgrid(np.fft.fftfreq(n), np.fft.fftfreq(n), indexing="ij")
    f *= np.exp(-(kx ** 2 + ky ** 2) * (n / 8.0) ** 2 * 2)
    v = np.real(np.fft.ifft2(f))
    return (v - v.min()) / max(v.max() - v.min(), 1e-9)


def main():
    name = L.param("name")
    pats = L.param("cover")
    if not name or not pats:
        raise RuntimeError("name and cover are required")
    pats = pats if isinstance(pats, list) else [pats]
    dry = bool(L.param("dry_run", False))
    if bpy.data.objects.get(name) is not None:
        raise RuntimeError(f"{name!r} already exists: it is never replaced")
    scn = bpy.context.scene
    src = [o for o in scn.objects if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, g) for g in pats)]
    if not src:
        raise RuntimeError(f"cover: nothing matches {pats}")
    tris = []
    for o in src:
        me = o.data
        me.calc_loop_triangles()
        for t in me.loop_triangles:
            tris.append([o.matrix_world @ me.vertices[v].co for v in t.vertices])
    P = np.array([[list(c) for c in tr] for tr in tris])
    nrm = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    area = 0.5 * np.linalg.norm(nrm, axis=1)
    nrm = nrm / np.maximum(np.linalg.norm(nrm, axis=1)[:, None], 1e-12)
    zlo = float(P[..., 2].min())
    min_z = float(L.param("min_z", zlo + 0.15))
    cz = P[:, :, 2].mean(1)
    mnz = -2.0 if L.param("include_undersides", False) else float(L.param("min_normal_z", -0.35))   # -2: nothing is skipped for facing down
    ok = (area > 1e-9) & (cz > min_z) & (nrm[:, 2] > mnz)
    skipped = {"below_min_z": int((cz <= min_z).sum()), "undersides": int(((nrm[:, 2] <= mnz) & (cz > min_z)).sum())}
    total_area = float(area[ok].sum())
    density = float(L.param("density", 140))
    n = int(min(float(L.param("max_cards", 6000)), density * total_area))
    sz = L.param("size_m", [0.18, 0.34])
    off = L.param("outward_m", [0.0, 0.04])
    tilt = math.radians(float(L.param("tilt_deg", 35)))
    rng = np.random.default_rng(int(L.param("seed", 1)))
    idx = np.nonzero(ok)[0]
    pr = area[idx] / area[idx].sum()
    pick = rng.choice(idx, size=n, p=pr)
    lo_s, hi_s = float(sz[0]), float(sz[1])
    cards = []
    for ti in pick:
        a, b = rng.random(), rng.random()
        if a + b > 1:
            a, b = 1 - a, 1 - b
        p = P[ti, 0] + a * (P[ti, 1] - P[ti, 0]) + b * (P[ti, 2] - P[ti, 0])
        nv = nrm[ti].copy()
        # tilt: rotate the normal by up to `tilt` about a random axis perpendicular to it
        ax = np.cross(nv, rng.standard_normal(3))
        ax = ax / max(np.linalg.norm(ax), 1e-9)
        th = tilt * rng.random()
        nv2 = nv * math.cos(th) + np.cross(ax, nv) * math.sin(th) + ax * np.dot(ax, nv) * (1 - math.cos(th))
        t1 = np.cross(nv2, rng.standard_normal(3))
        t1 = t1 / max(np.linalg.norm(t1), 1e-9)
        t2 = np.cross(nv2, t1)
        s = rng.uniform(lo_s, hi_s) / 2
        c = p + nv * rng.uniform(float(off[0]), float(off[1])) + nv2 * 0.004 * rng.random()
        cards.append((c, t1 * s, t2 * s, int(rng.integers(0, 4))))
    rep = {"dry_run": dry, "cover": [o.name for o in src][:30], "covered_objects": len(src), "covered_surface_m2": round(total_area, 2), "cards": n, "triangles": 2 * n, "vertices": 4 * n, "skipped_triangles": skipped, "min_z": round(min_z, 3), "density_per_m2": density}
    if dry or n == 0:
        L.finish(rep, save=False)
        return
    lf = L.param("leaf") or {}
    args = {k: lf[k] for k in ("leaves", "gloss", "length", "kind", "colour2") if k in lf}
    args["cells"] = 2   # the card crops are the 4 cells of the sheet: every leaf lies whole inside one
    photo = None
    if lf.get("image"):
        tex, photo = photo_atlas(lf, int(lf.get("size_px", 1024)), int(L.param("seed", 1)))
        mat, imgs, files, t = TM.make_set(f"{name}-leaf", None, int(lf.get("size_px", 1024)), int(L.param("seed", 1)), {}, out_dir=L.ARGS["out_dir"], tex=tex)
    else:
        mat, imgs, files, t = TM.make_set(f"{name}-leaf", "leaf", int(lf.get("size_px", 1024)), int(L.param("seed", 1)), args, colour=lf.get("colour"), out_dir=L.ARGS["out_dir"])
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    for c, a, b, q in cards:
        vs = [bm.verts.new(tuple(c + sa * a + sb * b)) for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        f = bm.faces.new(vs)
        u0, v0 = (q % 2) * 0.5, (q // 2) * 0.5
        for lp, (du, dv) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            lp[uvl].uv = (u0 + du * 0.5, v0 + dv * 0.5)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    scn.collection.objects.link(ob)
    bpy.context.view_layer.update()
    pts = np.array([list(v.co) for v in me.vertices])
    olo, ohi = np.array([P[..., i].min() for i in range(3)]), np.array([P[..., i].max() for i in range(3)])
    rep.update({"object": name, "material": mat.name, "atlas": {"photo_patches_from_top_left_fractions_x_y_coverage": photo, "size_px": imgs["albedo"].size[0], "alpha_coverage": round(float(t["alpha"].mean()), 3)},
                "new_bbox_m": [[round(float(x), 3) for x in pts.min(0)], [round(float(x), 3) for x in pts.max(0)]], "covered_bbox_m": [[round(float(x), 3) for x in olo], [round(float(x), 3) for x in ohi]],
                "notes": ["the covered shapes are untouched: archive them (scene_archive) or darken them (material_solid) as you prefer", "cards stand slightly off the surface, so the new bounding box is a few cm larger than the shape's"]})
    L.finish(rep, save=True, files=list(files.values()))


L.run(main)
