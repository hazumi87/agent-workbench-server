"""lightmap_bake — a unique lightmap UV layer on chosen STATIC receivers and, for chosen bulbs, one single-channel linear response map each (direct diffuse light only, shadows included, no albedo, no ambient, no bounce). Saves a checkpoint (not with dry_run).

Run it on a COPY / derivative job of a finished scene: it adds a UV layer to the receivers and nothing else (lights, materials, hierarchy and clips are put back exactly).
params:
  receivers   names or globs of the static meshes that receive light (deck, wall, a chair, a post...). Each needs its own mesh data (a shared mesh is made single-user) and scale 1 (else the report warns). Never a marker object, a light, or an animated mesh (refused).
  bulbs       bulb ids (`bulb_<id>.light` must exist, else an exact LIGHT object name such as an emitter from emitters_make) or "bulb_*" style globs of light object names; each gets a map. Default none (UV only).
  atlas_px    the square atlas (default 512); margin_px  GUTTER between islands and from the border, in texels, kept by our own packer (default 8 = twice the padding); the report's gutter_violations_2px must be 0
  dilate_px   texels of padding filled around every island, mask label 2 (default 4, at least 2 for v1.1)
  samples     Cycles samples per map (default 128); no denoising
  name        base name of the files (default "lightmaps")
  views       "maps" (two pictures drawn from the stored values themselves, not a render: <name>-maps-top.png from above and <name>-maps-front.png from the front, grey = sqrt(sum of all maps / its 99th percentile), red dots = the bulbs) and "atlas" (the atlas as a picture): default both; res px (default 800)
  density     list of {"objects": glob, "scale": 0.25}: LINEAR texel density of the matched receivers relative to the rest (default 1 = same; 0.25 = a quarter of the texels per metre, one sixteenth of the texels per area): a large flat ground area at 0.25 leaves room in the atlas for small detailed parts. The report gives mm_per_texel for each receiver
  angle_limit_deg  smart-project chart angle (default 66): faces whose normals differ less than this stay in one chart; a larger angle (80-89) makes fewer, bigger charts on curved parts (more stretch). The report gives `charts` and `faces_per_chart` for every receiver and `charts_total`
  weld_m      0 (default: off). A position tolerance in m (e.g. 0.00001): the receivers' vertices at the same position are merged BEFORE unwrapping, so adjacent faces can share a chart (fewer, larger charts for tube-like meshes). UV0 and the shape are kept; custom split normals may be lost: look at the result. This changes the receivers' meshes in the checkpoint (not with dry_run, where only the temporary result is not saved)
  collapse_folded_polygons  optional threshold in m2 (e.g. 1e-6): a polygon whose own triangles overlap in the LightmapUV (a quad folded over itself) and is smaller than this gets ONE UV point for all its loops, so it covers no texel centre and no longer counts as an overlap; LightmapUV only (vertices, normals, UV0 untouched); larger folded polygons are listed in `layout.folded_polygons` and left alone
  weld_uv_only  true (with weld_m): the receivers' own meshes are NOT welded: the unwrap and the pack run on temporary welded copies and only the new LightmapUV is copied back loop by loop (vertices, normals, UV0 untouched); polygon and loop counts and every loop's vertex position (within 10 x weld_m) are checked, any mismatch refuses the run; the report has `weld_uv_transfer`
  packer      "shelf" (default; the layout the proof used) | "skyline": every chart is turned to its minimum bounding rectangle (and 90 degrees when that packs lower) and skyline-packed: a denser atlas (same gutter rule); the report `pack` gives rect_fill_percent and which packer ran
  min_chart_px  0 (default: off; skyline packer only): a chart narrower than this many texels in its short side is widened to it (anisotropic, e.g. 1.5), so a long thin strip always holds a texel centre instead of falling between two rows; the report's empty_charts shows the need
  tie_rule    "inclusive" (default, the proof sets: a texel centre exactly on a triangle edge counts for every triangle sharing it, and for the outer edge of a chart) | "top_left_b" (the rule the target runtime's loader uses: such a centre belongs to at most one triangle and is dropped on a chart's outer edge when that edge is not the owning side): the mask labels and the coverage then agree with that loader. The layout report gives `texel_centres_exactly_on_a_triangle_edge`: avoid them (0 is best) by choosing min_chart_px that is not a multiple of 0.5 (1.6, not 1.5) "top_left_b_f32": the same rule evaluated on the numbers the GLB exporter writes (u, 1 - v rounded to float32): with "top_left_b" centres within about 3e-5 texel of an edge can be labelled differently from the exported GLB; this value removes that difference
  split_sparse_charts  list of {"objects": glob, "min_fill": 0.3, "max_depth": 4}: UV-ONLY cut of SPARSE charts of the matched receivers (a closed ring/frame of thin trim strips is one chart whose minimum bounding rectangle is mostly empty, so its strips fall between texel centres): an island whose polygons fill less than min_fill of that rectangle is cut recursively at the largest gap along its long side; the pieces are moved apart in UV so the packer treats them as separate charts (and widens each thin one by min_chart_px). The report's `split_sparse_charts` lists charts before, islands split and charts added per receiver. Geometry, UV0 and normals are never touched
  split_uv_overlaps  true (default false): UV-ONLY separation of coincident faces: polygons of one receiver whose LightmapUV triangles overlap (faces lying on top of each other in 3D land on the same UV place) are moved by a translation into separate layers so the packer gives them separate charts; no geometry, topology, UV0, normals or material changes, no distortion; the report `split_uv_overlaps` gives the pairs, the polygons moved and the receivers touched
  zero_on     {"<bulb id or light object name>": ["<receiver name or glob>", ...]}: that bulb's map is set to 0 on the texels of those receivers (the bulb's own diffuser shell: no self contribution); every other bulb's map on those receivers, and this bulb's map on all other receivers, is unchanged. Applied to the baked values before the distance clamp and the padding fill, so the zero reaches the dilated border too. Does not change which meshes cast (see exclude_casters). The report's maps[].zero_on lists, per receiver, the texels zeroed and how many of them were lit. Names that match no receiver are refused
  exclude_casters  globs of meshes that must NOT block light during the bake (default ["bulb_*.diffuser"]); the report's `casters` lists who casts, who is excluded and which casters are animated (their pose is the checkpoint's rest pose)
  bake_light_radius_m  emitter radius for the bake and the calibration (default 0: contract v1.1); distance_min_m (default 0.1); dilate_px (default 4); bake_margin_px (default 0, leave it)
  probes      random covered texels per bulb for the PHYSICAL check (default 600): each is tested for a clear ray to the bulb and compared with cos/max(d, d_min)^2 (see `maps[].probes`); separate from the UV/GLB check in verb 85
  pose_globs  objects whose saved rotation is reported as `pose_as_saved` (default ["Louver_*", "Louvers_*"]): unique rest angles with counts, and whether any clip would play
  dry_run     true: UV layer, overlap/density check and the calibration are done, NO bulb is baked, nothing is saved
Contract (the value of a map texel; stated, then MEASURED, never assumed):
  value = illuminance at that surface point from ONE bulb of intensity 1 (candela) = cos(theta) / d^2 (1/m^2) where nothing blocks the bulb; 0 in shadow; softer at the shadow edge by the light's radius. Runtime: radiance = albedo / pi x sum_i( I_i(R,G,B) x map_i ).
  Calibration: a white plane 1.0 m under a point light of radius `bake_light_radius_m` (default 0, hard shadows: contract v1.1 emitter_radius_m 0; same Cycles settings) is baked; the centre texel gives the raw-to-contract factor. After each map the verb also compares every covered texel with the analytic unoccluded value: `ratio_max` (must be <= about 1.05: a bake never beats the open-air value), `within_5_percent` (texels that match: open, facing), `shadowed` (texels below half).
  UV layers: the receivers keep their first UV layer as it was (an empty `UVMap` is made when there is none, so TEXCOORD_0 stays what it was); the new layer `LightmapUV` is TEXCOORD_1 in a glTF written afterwards.
Returns: receivers (faces, islands, UV area, mm per texel), layout (overlap texels (must be 0), coverage %, density min/max), calibration, maps (per bulb: file, raw max, contract max, lit %, checks), files; sidecars are written into `lightmaps/` of the step's output folder with `<name>.lightmaps.json` (bulb id, file, atlas size, receiver list, units, contract text).
"""
import fnmatch
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import _handview as HV  # noqa: E402

LM = "LightmapUV"
E0 = 100.0  # watts of the one lit bulb during a bake and of the calibration light (the factor cancels)


def is_animated(o):
    ad = o.animation_data
    return bool(ad and (ad.action or ad.nla_tracks))


def pick(globs, kinds):
    out = []
    for g in globs:
        hit = sorted([o for o in bpy.context.scene.objects if o.type in kinds and "blender_agent_marker" not in o and fnmatch.fnmatchcase(o.name, g)], key=lambda x: x.name)
        if not hit:
            raise RuntimeError(f"nothing matches {g!r}")
        for o in hit:
            if o not in out:
                out.append(o)
    return out


CHARTS = {}
PACK = {}
LOOPMAP = {}  # weld_uv_only: (receiver index, original loop) -> (receiver index, loop of the welded copy that the UV came from)
CHART_OF = {}  # (receiver index, loop) -> chart id from the final LightmapUV, set by chart_maps
CHART_FIRST = []  # chart id (from the final LightmapUV) -> (receiver index, first loop), set by chart_maps
ITEMS = []  # the charts of the last pack: {"ls": [(receiver index, loop index)], ...}


def hull2d(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def min_rect(pts):
    """the rotation (2x2 matrix) of a chart's UV points that gives the smallest bounding rectangle (rotating calipers over the convex hull); returns (M, width, height, q0)"""
    h = hull2d(pts)
    best = None
    for i in range(len(h)):
        a, b = h[i], h[(i + 1) % len(h)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        if n < 1e-12:
            continue
        c, sn = dx / n, dy / n
        M = (c, sn, -sn, c)  # rotates the edge onto +X
        qs = [(M[0] * x + M[1] * y, M[2] * x + M[3] * y) for x, y in h]
        x0, x1 = min(q[0] for q in qs), max(q[0] for q in qs)
        y0, y1 = min(q[1] for q in qs), max(q[1] for q in qs)
        ar = (x1 - x0) * (y1 - y0)
        if best is None or ar < best[0] - 1e-15:
            best = (ar, M, x1 - x0, y1 - y0, (x0, y0))
    if best is None:
        x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
        y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
        return (1.0, 0.0, 0.0, 1.0), x1 - x0, y1 - y0, (x0, y0)
    return best[1], best[2], best[3], best[4]


def skyline_place(rects, W, H):
    """bottom-left skyline packing; rects = [(w, h)] already in placement order; each may be turned 90 degrees when that lowers its top; returns [(x, y, turned)] or None"""
    sky = [[0, 0, W]]
    out = []
    for w0, h0 in rects:
        best = None
        for turned, (w, h) in ((False, (w0, h0)), (True, (h0, w0))):
            if turned and w0 == h0:
                continue
            for i in range(len(sky)):
                x = sky[i][0]
                if x + w > W:
                    break
                y = 0
                rem = w
                j = i
                while rem > 0:
                    y = max(y, sky[j][1])
                    rem -= sky[j][2]
                    j += 1
                    if j >= len(sky) and rem > 0:
                        y = None
                        break
                if y is None or y + h > H:
                    continue
                sc_ = (y + h, x)
                if best is None or sc_ < best[0]:
                    best = (sc_, x, y, w, h, turned)
        if best is None:
            return None
        _, x, y, w, h, turned = best
        new = [x, y + h, w]
        ns = []
        for sg in sky:
            sx, sy, sw = sg
            ex = sx + sw
            if ex <= x or sx >= x + w:
                ns.append(sg)
                continue
            if sx < x:
                ns.append([sx, sy, x - sx])
            if ex > x + w:
                ns.append([x + w, sy, ex - (x + w)])
        ns.append(new)
        ns.sort(key=lambda t: t[0])
        mg = []
        for sg in ns:
            if mg and mg[-1][1] == sg[1] and mg[-1][0] + mg[-1][2] == sg[0]:
                mg[-1][2] += sg[2]
            else:
                mg.append(sg)
        sky = mg
        out.append((x, y, turned))
    return out


def pack_skyline(recv, items, atlas, gutter, min_px=0.0):
    """charts turned to their minimum bounding rectangle (and 90 degrees when that packs lower), skyline packing, one uniform scale (times the density weights), gutter texels between charts and from the border"""
    for it in items:
        pts = [tuple(recv[oi].data.uv_layers[LM].data[l].uv) for oi, l in it["ls"]]
        M, bw, bh, q0 = min_rect(pts)
        k = it["k"]
        it.update({"M": M, "bw": max(bw, 1e-6) * k, "bh": max(bh, 1e-6) * k, "q0": q0})
    items.sort(key=lambda i: -max(i["bw"], i["bh"]))
    G = gutter
    W = H = atlas - G

    why = {}

    def layout(sc):
        rects = []
        for it in items:
            w, h = math.ceil(max(it["bw"] * sc * atlas, min_px)) + 1 + G, math.ceil(max(it["bh"] * sc * atlas, min_px)) + 1 + G
            if w > W or h > H:
                if h <= W and w <= H:
                    pass
                else:
                    why.update({"scale": sc, "reason": "a chart is wider than the atlas", "receiver": recv[it["ls"][0][0]].name, "chart_texels": [w, h], "density_weight": it["k"]})
                    return None
            rects.append((w, h))
        pl = skyline_place(rects, W, H)
        if pl is None:
            why.update({"scale": sc, "reason": "no room left (skyline)", "rect_texels": sum((w - G) * (h - G) for w, h in rects), "with_gutter_texels": sum(w * h for w, h in rects)})
        return None if pl is None else (rects, pl)
    area = sum(i["bw"] * i["bh"] for i in items)
    hi = 1.0 / math.sqrt(max(area, 1e-12))
    lo = hi * 0.05
    best = None
    for _ in range(12):
        r = layout(lo)
        if r is not None:
            best = r
            break
        lo *= 0.5
    if best is None:
        mn = (math.ceil(min_px) + 1 + G) ** 2
        raise RuntimeError("the charts do not fit the atlas with this gutter: raise atlas_px or lower margin_px (" + json.dumps({"charts": len(items), "atlas_px": atlas, "gutter": G, "min_chart_px": min_px, "smallest_possible_total_texels": len(items) * mn, "atlas_texels": atlas * atlas, "last_try": why}) + ")")
    for _ in range(14):
        mid = (lo + hi) / 2
        r = layout(mid)
        if r is None:
            hi = mid
        else:
            lo, best = mid, r
    sc = lo
    rects, pl = best
    rect_area = 0
    bottom = 0
    for it, (w, h), (x, y, turned) in zip(items, rects, pl):
        rect_area += (w - G) * (h - G)
        bottom = max(bottom, y + (w if turned else h))
        M = it["M"]
        if turned:  # extra quarter turn: (x, y) -> (y, -x) on the already rotated chart
            M = (M[2], M[3], -M[0], -M[1])
            q0x = min(M[0] * pu + M[1] * pv for pu, pv in [tuple(recv[oi].data.uv_layers[LM].data[l].uv) for oi, l in it["ls"]])
            q0y = min(M[2] * pu + M[3] * pv for pu, pv in [tuple(recv[oi].data.uv_layers[LM].data[l].uv) for oi, l in it["ls"]])
        else:
            q0x, q0y = it["q0"]
        it["place"] = (x + G, y + G, M, q0x, q0y)
    for it, turned_ in zip(items, [t for _, _, t in pl]):
        # a chart narrower than min_px texels in its short side is widened to min_px (anisotropic: it then always holds a texel centre)
        a_, b_ = it["bw"] * sc * atlas, it["bh"] * sc * atlas
        fa, fb = max(1.0, min_px / max(a_, 1e-9)), max(1.0, min_px / max(b_, 1e-9))
        it["fx"], it["fy"] = (fb, fa) if turned_ else (fa, fb)
    for it in items:
        px, py, M, q0x, q0y = it["place"]
        k = it["k"]
        for oi, l in it["ls"]:
            d = recv[oi].data.uv_layers[LM].data[l]
            u, v = d.uv
            qx, qy = M[0] * u + M[1] * v, M[2] * u + M[3] * v
            fx, fy = it["fx"], it["fy"]
            d.uv = ((px + (qx - q0x) * k * sc * atlas * fx) / atlas, (py + (qy - q0y) * k * sc * atlas * fy) / atlas)
    # what stops the scale from growing? try 3 % more: a chart that no longer fits the atlas width, or no room left
    limit = {"reason": "none (the search upper bound)"}
    try_sc = sc * 1.03
    widest = None
    for it in items:
        a_, b_ = it["bw"] * try_sc * atlas, it["bh"] * try_sc * atlas
        w_ = math.ceil(max(a_, min_px)) + 1 + G
        h_ = math.ceil(max(b_, min_px)) + 1 + G
        if (w_ > W or h_ > H) and not (h_ <= W and w_ <= H):
            widest = (it, w_, h_)
            break
    if widest is not None:
        it, w_, h_ = widest
        limit = {"reason": "a chart no longer fits the atlas width", "chart_receiver": recv[it["ls"][0][0]].name, "chart_texels_at_limit": [w_, h_], "chart_faces_loops": len(it["ls"]), "density_weight": it["k"]}
    elif layout(try_sc) is None:
        limit = {"reason": "the atlas is full at a 3 % larger scale (skyline packing)"}
    PACK.clear()
    PACK.update({"scale_limit": limit, "packer": "skyline", "charts": len(items), "rect_texels": int(rect_area), "atlas_texels": atlas * atlas,
                 "rect_fill_percent": round(100.0 * rect_area / (atlas * atlas), 2), "bottom_used_percent": round(100.0 * bottom / atlas, 2)})


def pack_islands(recv, atlas, gutter, weights=None, packer="shelf"):
    """own shelf packer (Blender's pack_islands margin is not honoured here): islands = loops joined by polygon and by a shared vertex with the same UV; one uniform scale for all (equal texel density);
    `weights` {receiver index: linear density factor} lets chosen receivers take fewer (or more) texels per metre; axis-aligned rectangles on shelves, `gutter` texels apart and from the border, on whole-texel positions"""
    parent = {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        parent[find(a)] = find(b)
    for oi, o in enumerate(recv):
        me = o.data
        uv = me.uv_layers[LM].data
        seen = {}
        for poly in me.polygons:
            ls = list(poly.loop_indices)
            for l in ls[1:]:
                union((oi, ls[0]), (oi, l))
            for l in ls:
                k = (me.loops[l].vertex_index, round(uv[l].uv[0], 5), round(uv[l].uv[1], 5))
                if k in seen:
                    union((oi, seen[k]), (oi, l))
                else:
                    seen[k] = l
    isl = {}
    for oi, o in enumerate(recv):
        uv = o.data.uv_layers[LM].data
        for l in range(len(o.data.loops)):
            isl.setdefault(find((oi, l)), []).append((oi, l))
    items = []
    for key, ls in isl.items():
        us = [recv[oi].data.uv_layers[LM].data[l].uv for oi, l in ls]
        x0, x1 = min(u[0] for u in us), max(u[0] for u in us)
        y0, y1 = min(u[1] for u in us), max(u[1] for u in us)
        k = (weights or {}).get(ls[0][0], 1.0)
        items.append({"ls": ls, "x0": x0, "y0": y0, "k": k, "w": max(x1 - x0, 1e-6) * k, "h": max(y1 - y0, 1e-6) * k})
    ITEMS[:] = items
    CHARTS.clear()
    for it in items:
        CHARTS[it["ls"][0][0]] = CHARTS.get(it["ls"][0][0], 0) + 1
    items.sort(key=lambda i: -i["h"])
    if packer == "skyline":
        return pack_skyline(recv, items, atlas, gutter, MINPX[0])

    def layout(sc):
        x = y = gutter
        row_h = 0.0
        out = []
        for it in items:
            w, h = math.ceil(it["w"] * sc * atlas) + 1, math.ceil(it["h"] * sc * atlas) + 1
            if x + w + gutter > atlas:
                x, y, row_h = gutter, y + row_h + gutter, 0.0
            if y + h + gutter > atlas or w + 2 * gutter > atlas:
                return None
            out.append((x, y, w, h))
            x += w + gutter
            row_h = max(row_h, h)
        return out
    lo, hi = 1e-6, 4.0 / max(max(i["w"] for i in items), max(i["h"] for i in items))
    best = None
    for _ in range(60):
        mid = (lo + hi) / 2
        r = layout(mid)
        if r is None:
            hi = mid
        else:
            lo, best = mid, r
    if best is None:
        raise RuntimeError("the islands do not fit the atlas with this gutter: raise atlas_px or lower margin_px")
    sc = lo
    rect = sum(w * h for _, _, w, h in best)
    PACK.clear()
    PACK.update({"charts": len(best), "rect_texels": int(rect), "atlas_texels": atlas * atlas, "rect_fill_percent": round(100.0 * rect / (atlas * atlas), 2),
                 "bottom_used_percent": round(100.0 * max(y + h for _, y, _, h in best) / atlas, 2)})
    for it, (px, py, w, h) in zip(items, best):
        for oi, l in it["ls"]:
            d = recv[oi].data.uv_layers[LM].data[l]
            d.uv = ((px + (d.uv[0] - it["x0"]) * it["k"] * sc * atlas) / atlas, (py + (d.uv[1] - it["y0"]) * it["k"] * sc * atlas) / atlas)


WELDED = {}


def weld_receivers(recv, dist):
    """merge vertices that share a POSITION (within dist): split vertices keep adjacent faces in separate charts; UV0 (per loop) and the shape are kept; custom split normals may be lost"""
    import bmesh
    WELDED.clear()
    for o in recv:
        me = o.data
        n0 = len(me.vertices)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=dist)
        bm.to_mesh(me)
        bm.free()
        me.update()
        WELDED[o.name] = [n0, len(me.vertices)]


SPLIT = {}


def _tri_overlap(a, b, eps):
    """True when two UV triangles share AREA (touching along an edge or at a point is not overlap): separating-axis test over the six edge normals"""
    for T in (a, b):
        for i in range(3):
            e = T[(i + 1) % 3] - T[i]
            n = np.array((-e[1], e[0]))
            pa, pb = a @ n, b @ n
            if pa.max() <= pb.min() + eps * np.linalg.norm(n) or pb.max() <= pa.min() + eps * np.linalg.norm(n):
                return False
    return True


def split_uv_overlaps(recv):
    """UV-only separation of coincident faces: polygons of ONE receiver whose LightmapUV triangles overlap (faces lying on top of each other in 3D project onto the same UV place) are moved into separate UV 'layers' (a translation in U, nothing else changes: no distortion, no geometry, no topology), so the packer lays them out as separate charts. Greedy graph colouring of the overlap pairs."""
    SPLIT.clear()
    for o in recv:
        me = o.data
        me.calc_loop_triangles()
        uv = me.uv_layers[LM].data
        tris = list(me.loop_triangles)
        if not tris:
            continue
        P = np.array([[uv[l].uv[:] for l in t.loops] for t in tris], np.float64)
        poly = np.array([t.polygon_index for t in tris])
        lo, hi = P.min(1), P.max(1)
        ext = float(max(hi[:, 0].max() - lo[:, 0].min(), hi[:, 1].max() - lo[:, 1].min(), 1e-9))
        eps = 1e-7 * ext
        pairs = set()
        n = len(tris)
        for i in range(n):
            cand = np.nonzero((lo[i + 1:, 0] < hi[i, 0] - eps) & (hi[i + 1:, 0] > lo[i, 0] + eps) & (lo[i + 1:, 1] < hi[i, 1] - eps) & (hi[i + 1:, 1] > lo[i, 1] + eps))[0] + i + 1
            for j in cand:
                if poly[i] != poly[j] and _tri_overlap(P[i], P[j], eps):
                    pairs.add((int(min(poly[i], poly[j])), int(max(poly[i], poly[j]))))
        if not pairs:
            continue
        adj = {}
        for a_, b_ in pairs:
            adj.setdefault(a_, set()).add(b_)
            adj.setdefault(b_, set()).add(a_)
        color = {}
        for pidx in sorted(adj, key=lambda k: -len(adj[k])):
            used = {color[q] for q in adj[pidx] if q in color}
            c = 0
            while c in used:
                c += 1
            color[pidx] = c
        step = (hi[:, 0].max() - lo[:, 0].min()) + 10.0 * ext
        moved = 0
        for p_ in me.polygons:
            c = color.get(p_.index, 0)
            if c:
                for li in p_.loop_indices:
                    u, v = uv[li].uv
                    uv[li].uv = (u + c * step, v)
                moved += 1
        SPLIT[o.name] = {"overlapping_polygon_pairs": len(pairs), "polygons_in_conflict": len(adj), "layers": max(color.values()) + 1, "polygons_moved": moved}



SPARSE = []
SPARSE_REP = {}


def split_sparse_charts(recv):
    """UV-ONLY split of SPARSE charts (a closed ring or frame of thin strips is one chart whose bounding rectangle is mostly empty: the strips fall between texel centres): for receivers matching a `split_sparse_charts` rule, an island whose polygons fill less than `min_fill` of its minimum bounding rectangle is cut (recursively, at the largest gap along its long side) into pieces; the pieces are moved apart in UV so they stop sharing UV at their common vertices and the packer treats them as separate charts (each thin strip is then widened by min_chart_px). Geometry, UV0 and normals are never touched."""
    SPARSE_REP.clear()
    for o in recv:
        real = o.name[4:] if o.name.startswith("wd__") else o.name
        rule = next((r for r in SPARSE if fnmatch.fnmatchcase(real, r["objects"])), None)
        if rule is None:
            continue
        min_fill = float(rule.get("min_fill", 0.3))
        max_depth = int(rule.get("max_depth", 4))
        me = o.data
        uv = me.uv_layers[LM].data
        n = len(me.polygons)
        par = list(range(n))

        def find(a):
            while par[a] != a:
                par[a] = par[par[a]]
                a = par[a]
            return a
        seen = {}
        for p_ in me.polygons:
            for l in p_.loop_indices:
                k = (me.loops[l].vertex_index, round(uv[l].uv[0], 5), round(uv[l].uv[1], 5))
                if k in seen:
                    par[find(p_.index)] = find(seen[k])
                else:
                    seen[k] = p_.index
        isl = {}
        for p_ in me.polygons:
            isl.setdefault(find(p_.index), []).append(p_.index)

        def poly_area(pi):
            pts = [uv[l].uv for l in me.polygons[pi].loop_indices]
            return abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))) * 0.5

        def pieces(polys, depth):
            pts = [tuple(uv[l].uv) for pi in polys for l in me.polygons[pi].loop_indices]
            M, bw, bh, q0 = min_rect(pts)
            area = sum(poly_area(pi) for pi in polys)
            fill = area / max(bw * bh, 1e-18)
            if fill >= min_fill or depth >= max_depth or len(polys) < 2:
                return [polys]
            ax = 0 if bw >= bh else 1
            cs = []
            for pi in polys:
                us = [uv[l].uv for l in me.polygons[pi].loop_indices]
                cu, cv = sum(u[0] for u in us) / len(us), sum(u[1] for u in us) / len(us)
                cs.append(M[0] * cu + M[1] * cv if ax == 0 else M[2] * cu + M[3] * cv)
            order = sorted(range(len(polys)), key=lambda i: cs[i])
            gaps = [(cs[order[i + 1]] - cs[order[i]], i) for i in range(len(order) - 1)]
            cut = max(gaps)[1] if gaps and max(gaps)[0] > 0 else len(order) // 2 - 1
            left = [polys[i] for i in order[:cut + 1]]
            right = [polys[i] for i in order[cut + 1:]]
            if not left or not right:
                return [polys]
            return pieces(left, depth + 1) + pieces(right, depth + 1)
        before, split_isl, added = len(isl), 0, 0
        counter = 0
        for key, polys in isl.items():
            if len(polys) < 2:
                continue
            ps = pieces(polys, 0)
            if len(ps) < 2:
                continue
            split_isl += 1
            for piece in ps[1:]:
                counter += 1
                added += 1
                for pi in piece:
                    for l in me.polygons[pi].loop_indices:
                        u, v = uv[l].uv
                        uv[l].uv = (u + 7.0 * counter, v)
        SPARSE_REP[real] = {"charts_before": before, "islands_split": split_isl, "charts_added": added, "min_fill": min_fill}

TRANSFER = {}
DUPS = {}
SPLITOV = [False]
PACKER = ["shelf"]
LASTHITS = {}  # receiver index -> (loops of triangles that hold a texel centre, area per loop) of the last raster()
TIE_RULE = ["inclusive"]
TIES = [0]
MINPX = [0.0]


def make_uvs_welded_copy(recv, atlas, margin_px, density, angle_deg, weld_m):
    """unwrap and pack on position-welded TEMPORARY copies, then copy only the new LightmapUV per loop back to the originals: their vertices, normals, UV0 and everything else stay as they are"""
    import bmesh
    TRANSFER.clear()
    LOOPMAP.clear()
    dups = []
    for o in recv:
        if o.data.users > 1:
            o.data = o.data.copy()
        me = o.data.copy()
        bm = bmesh.new()
        bm.from_mesh(me)
        # coincident DUPLICATE polygons (two polygons on the same positions, e.g. back to back or repeated) would be merged into one by the weld and the polygon count would no longer match: the second and later copies keep their own vertices (not welded), so they stay separate polygons and get their own chart
        q = max(weld_m * 4.0, 1e-6)
        groups = {}
        for f in bm.faces:
            groups.setdefault(tuple(sorted((round(v.co.x / q), round(v.co.y / q), round(v.co.z / q)) for v in f.verts)), []).append(f)
        keep_apart = set()
        ndup = 0
        for g in groups.values():
            for f in g[1:]:
                ndup += 1
                for v in f.verts:
                    keep_apart.add(v)
        DUPS[o.name] = ndup
        bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if v not in keep_apart], dist=weld_m)
        bm.to_mesh(me)
        bm.free()
        d = bpy.data.objects.new("wd__" + o.name, me)
        d.matrix_world = o.matrix_world
        bpy.context.scene.collection.objects.link(d)
        dups.append(d)
    dens = None
    if density:
        dens = []
        for rule in density:
            dens.append({"objects": "wd__" + rule["objects"], "scale": rule["scale"]})
    make_uvs(dups, atlas, margin_px, dens, angle_deg, 0.0)
    for oi_t, (o, d) in enumerate(zip(recv, dups)):
        a, b = o.data, d.data
        row = {"polygons": [len(a.polygons), len(b.polygons)], "loops": [len(a.loops), len(b.loops)], "mismatch_loops": 0, "max_position_error_m": 0.0, "ok": True, "mode": "order", "duplicate_polygons_kept_apart": DUPS.get(o.name, 0)}
        same_shape = len(a.polygons) == len(b.polygons) and len(a.loops) == len(b.loops) and all(pa.loop_total == pb.loop_total for pa, pb in zip(a.polygons, b.polygons))
        if not a.uv_layers:
            a.uv_layers.new(name="UVMap")  # the original has no UV: reserve an empty first layer (TEXCOORD_0) so LightmapUV exports as TEXCOORD_1, as in the non-weld path
        lay_a = a.uv_layers.get(LM) or a.uv_layers.new(name=LM)
        src = b.uv_layers[LM].data
        err = 0.0
        tol = weld_m * 10 + 1e-6
        if same_shape:
            for pa, pb in zip(a.polygons, b.polygons):
                for la, lb in zip(pa.loop_indices, pb.loop_indices):
                    e = (a.vertices[a.loops[la].vertex_index].co - b.vertices[b.loops[lb].vertex_index].co).length
                    err = max(err, e)
                    if e > tol:
                        row["mismatch_loops"] += 1
                    lay_a.data[la].uv = src[lb].uv
                    LOOPMAP[(oi_t, la)] = (oi_t, lb)
        else:
            # the weld removed degenerate polygons or shrank some (two corners of one polygon merged): match every ORIGINAL polygon to the welded polygon with the same centre, and every corner to the nearest corner of that polygon
            from mathutils.kdtree import KDTree
            row["mode"] = "position"
            kd = KDTree(len(b.polygons))
            for pb in b.polygons:
                kd.insert(pb.center, pb.index)
            kd.balance()
            unmatched = 0
            degenerate = 0
            kdv = KDTree(len(b.vertices))
            vpolys = {}
            for pb_ in b.polygons:
                for lb_ in pb_.loop_indices:
                    vpolys.setdefault(b.loops[lb_].vertex_index, set()).add(pb_.index)
            for v_ in b.vertices:
                kdv.insert(v_.co, v_.index)
            kdv.balance()
            used_b = set()
            for pa in a.polygons:
                degen = pa.area < 1e-9  # a zero-area polygon vanished in the weld: it takes the nearest welded polygon's chart (all its corners from the SAME polygon, so its UV triangle stays inside that chart)
                # a polygon that lost a corner in the weld (two corners on one position) has a different mean-of-corners centre, by up to the polygon's own length for a long sliver: the nearest welded centre can then be a NEIGHBOUR. Candidates are the welded polygons that own a vertex within tol of any original corner; the best holds the most original corners
                posa = [a.vertices[a.loops[la].vertex_index].co for la in pa.loop_indices]
                cand = set()
                for q_ in posa:
                    for _co, vi_, _d in kdv.find_range(q_, tol):
                        cand.update(vpolys.get(vi_, ()))
                if not cand:   # no welded corner near any original corner: fall back to the nearest centres
                    cand.update(i_ for _co, i_, _d in kd.find_n(pa.center, min(8, len(b.polygons))))
                pick_ = None
                for idx in cand:
                    pbc = b.polygons[idx]
                    vb = [b.vertices[b.loops[lb].vertex_index].co for lb in pbc.loop_indices]
                    hit = sum(1 for q_ in posa if min((q_ - w_).length for w_ in vb) <= tol)
                    key_ = (-hit, 1 if idx in used_b else 0, (pbc.center - pa.center).length)   # most corners matched, then a welded polygon not yet taken (coincident duplicates pair up in order), then the nearest centre
                    if pick_ is None or key_ < pick_[0]:
                        pick_ = (key_, idx)
                used_b.add(pick_[1])
                cands = [(None, pick_[1], 0.0)]
                pb = b.polygons[pick_[1]]
                if degen:
                    degenerate += 1
                for la in pa.loop_indices:
                    pos = a.vertices[a.loops[la].vertex_index].co
                    best = None
                    for lb in pb.loop_indices:
                        e = (pos - b.vertices[b.loops[lb].vertex_index].co).length
                        if best is None or e < best[0]:
                            best = (e, lb)
                    if best[0] > tol and not degen:
                        row["mismatch_loops"] += 1
                        unmatched += 1
                        ex_ = row.setdefault("unmatched_examples", [])
                        if len(ex_) < 6:
                            ex_.append({"polygon": pa.index, "area_m2": round(pa.area, 9), "corners": pa.loop_total, "welded_polygon_corners": pb.loop_total, "nearest_corner_distance_m": round(best[0], 8),
                                        "corner_m": [round(c, 5) for c in pos], "candidate_centres_m": [[round(c, 5) for c in b.polygons[i_].center] for _c, i_, _d in cands[:3]]})
                        continue
                    if not degen:
                        err = max(err, best[0])
                    lay_a.data[la].uv = src[best[1]].uv
                    LOOPMAP[(oi_t, la)] = (oi_t, best[1])
            row["degenerate_polygons_mapped"] = degenerate
            row["loops_unmatched"] = unmatched
        row["max_position_error_m"] = round(err, 8)
        row["ok"] = row["mismatch_loops"] == 0
        TRANSFER[o.name] = row
    for d in dups:
        me = d.data
        bpy.data.objects.remove(d, do_unlink=True)
        bpy.data.meshes.remove(me)
    if not all(r["ok"] for r in TRANSFER.values()):
        bad = [k for k, r in TRANSFER.items() if not r["ok"]]
        raise RuntimeError(f"weld_uv_only: the UV transfer did not match on {len(bad)} receivers, e.g. {bad[:3]}: nothing is changed in the report")
    for o in recv:
        o.data.uv_layers.active = o.data.uv_layers[LM]
        o.data.uv_layers[LM].active_render = False


def collapse_folded_polygons(recv, max_area_m2):
    """OPT-IN (`collapse_folded_polygons`: a threshold in m2): a polygon whose own triangles overlap each other in the LightmapUV (a quad folded over itself: its two triangles face opposite ways in 3D) covers some texel centres twice, which the loader's no-overlap rule refuses. When such a polygon is smaller than the threshold (a sliver) all its loops are given ONE UV point (its first loop's), so it covers no texel centre and no longer overlaps; only LightmapUV changes (vertices, normals, UV0 untouched). Larger folded polygons are left alone and listed. Returns the rows."""
    rows = []
    for oi, o in enumerate(recv):
        me = o.data
        me.calc_loop_triangles()
        lay = me.uv_layers[LM].data
        by_poly = {}
        for t in me.loop_triangles:
            by_poly.setdefault(t.polygon_index, []).append(t)
        for pi, ts in by_poly.items():
            if len(ts) < 2:
                continue
            tris = []
            for t in ts:
                q = [(lay[l].uv[0], lay[l].uv[1]) for l in t.loops]
                sa = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0])
                if abs(sa) < 1e-14:
                    continue
                tris.append(q if sa > 0 else q[::-1])
            ov = 0.0
            for i in range(len(tris)):
                for j in range(i + 1, len(tris)):
                    out = tris[i]
                    for k in range(3):
                        a, b = tris[j][k], tris[j][(k + 1) % 3]
                        inp, out = out, []
                        for m in range(len(inp)):
                            c, d = inp[m], inp[(m + 1) % len(inp)]
                            sc = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
                            sd = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])
                            if sc >= 0:
                                out.append(c)
                            if (sc >= 0) != (sd >= 0):
                                tt = sc / (sc - sd)
                                out.append((c[0] + tt * (d[0] - c[0]), c[1] + tt * (d[1] - c[1])))
                        if not out:
                            break
                    if len(out) >= 3:
                        ov += abs(sum(out[m][0] * out[(m + 1) % len(out)][1] - out[(m + 1) % len(out)][0] * out[m][1] for m in range(len(out)))) / 2.0
            if ov <= 1e-9:   # UV area as a fraction of the atlas: under a thousandth of a texel, numerical noise of a triangulation, not an overlap
                continue
            poly = me.polygons[pi]
            row = {"receiver": o.name, "polygon": pi, "area_m2": round(poly.area, 10), "uv_overlap_area": ov, "collapsed": poly.area <= max_area_m2}
            if row["collapsed"]:
                u0 = lay[poly.loop_start].uv.copy()
                for l in poly.loop_indices:
                    lay[l].uv = u0
            rows.append(row)
    return rows


def make_uvs(recv, atlas, margin_px, density=None, angle_deg=66.0, weld_m=0.0, uv_only=False):
    if weld_m > 0 and uv_only:
        return make_uvs_welded_copy(recv, atlas, margin_px, density, angle_deg, weld_m)
    for o in recv:
        if o.data.users > 1:
            o.data = o.data.copy()
    if weld_m > 0:
        weld_receivers(recv, weld_m)
    for o in recv:
        me = o.data
        if not me.uv_layers:
            me.uv_layers.new(name="UVMap")
        lay = me.uv_layers.get(LM) or me.uv_layers.new(name=LM)
        me.uv_layers.active = lay
    bpy.ops.object.select_all(action="DESELECT")
    for o in recv:
        o.select_set(True)
    bpy.context.view_layer.objects.active = recv[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg), island_margin=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")
    if SPLITOV[0]:
        split_uv_overlaps(recv)
    if SPARSE:
        split_sparse_charts(recv)
    weights = {}
    for rule in density or []:
        for oi, o in enumerate(recv):
            if fnmatch.fnmatchcase(o.name, rule["objects"]):
                weights[oi] = float(rule["scale"])
    pack_islands(recv, atlas, margin_px, weights, PACKER[0])
    for o in recv:
        o.data.uv_layers.active = o.data.uv_layers[LM]
        o.data.uv_layers[LM].active_render = False  # the glTF/render default stays the first layer


def raster(recv, atlas):
    """cover count, world position and normal per atlas texel (centre sampling) from the LightmapUV triangles; per-object stats"""
    cover = np.zeros((atlas, atlas), np.int32)
    pos = np.zeros((atlas, atlas, 3), np.float64)
    nrm = np.zeros((atlas, atlas, 3), np.float64)
    owner = np.full((atlas, atlas), -1, np.int32)
    stats = []
    empty = [0]
    ties = TIES
    ties[0] = 0
    bpy.context.view_layer.update()
    charts_of = {}
    for it in ITEMS:
        charts_of.setdefault(it["ls"][0][0], []).append(it)
    for oi, o in enumerate(recv):
        me = o.data
        me.calc_loop_triangles()
        uv = me.uv_layers[LM].data
        mw = o.matrix_world
        nm = mw.to_3x3().inverted_safe().transposed()
        a3d = a_uv = 0.0
        ov_self = ov_cross = 0
        e_n = 0
        e_area = 0.0
        e_list = []
        hit_loops, loop_area = set(), {}
        for t in me.loop_triangles:
            p = [np.array(mw @ me.vertices[v].co) for v in t.vertices]
            q = [np.array(uv[l].uv) * atlas for l in t.loops]
            ta = 0.5 * np.linalg.norm(np.cross(p[1] - p[0], p[2] - p[0]))
            a3d += ta
            for l_ in t.loops:
                loop_area[l_] = loop_area.get(l_, 0.0) + ta / 3.0
            den = (q[1][1] - q[2][1]) * (q[0][0] - q[2][0]) + (q[2][0] - q[1][0]) * (q[0][1] - q[2][1])
            a_uv += abs(den) / 2.0 / (atlas * atlas)
            if abs(den) < 1e-12:
                continue
            n = np.array((nm @ Vector(t.normal)).normalized())
            x0, x1 = int(max(0, math.floor(min(c[0] for c in q)))), int(min(atlas - 1, math.ceil(max(c[0] for c in q))))
            y0, y1 = int(max(0, math.floor(min(c[1] for c in q)))), int(min(atlas - 1, math.ceil(max(c[1] for c in q))))
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((q[1][1] - q[2][1]) * (xs - q[2][0]) + (q[2][0] - q[1][0]) * (ys - q[2][1])) / den
            w1 = ((q[2][1] - q[0][1]) * (xs - q[2][0]) + (q[0][0] - q[2][0]) * (ys - q[2][1])) / den
            w2 = 1 - w0 - w1
            m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            # centres lying EXACTLY on an edge: the inclusive rule above counts them for every triangle sharing the edge; a loader's top-left rule gives each to at most one triangle and drops them on a chart's outer edge
            qa, qb, qc = [(c[0], atlas - c[1]) for c in q]  # as exported: glTF v = 1 - v, row 0 = v 0
            if TIE_RULE[0] == "top_left_b_f32":  # the exporter stores TEXCOORD_1 as float32 (u, 1 - v): v near 0 is on a finer float32 grid than 1 - v, so the exported edge can move by up to about 3e-5 texel and turn an exact tie into a near miss (or the reverse); use the exported numbers
                qa, qb, qc = [(float(np.float32(uv[l].uv[0])) * atlas, float(np.float32(1.0 - float(np.float32(uv[l].uv[1])))) * atlas) for l in t.loops]
            if (qb[0] - qa[0]) * (qc[1] - qa[1]) - (qb[1] - qa[1]) * (qc[0] - qa[0]) < 0:
                qb, qc = qc, qb
            ys_ = atlas - ys
            ee = [(qb[0] - qa[0]) * (ys_ - qa[1]) - (qb[1] - qa[1]) * (xs - qa[0]), (qc[0] - qb[0]) * (ys_ - qb[1]) - (qc[1] - qb[1]) * (xs - qb[0]), (qa[0] - qc[0]) * (ys_ - qc[1]) - (qa[1] - qc[1]) * (xs - qc[0])]
            on_edge = m & ((ee[0] == 0) | (ee[1] == 0) | (ee[2] == 0))
            if on_edge.any():
                ties[0] += int(on_edge.sum())
            if TIE_RULE[0] in ("top_left_b", "top_left_b_f32"):
                edges_ = ((qb[0] - qa[0], qb[1] - qa[1], ee[0]), (qc[0] - qb[0], qc[1] - qb[1], ee[1]), (qa[0] - qc[0], qa[1] - qc[1], ee[2]))
                m = np.ones(ee[0].shape, bool)
                for dx_, dy_, e_ in edges_:
                    accb = (dy_ > 0) or (dy_ == 0 and dx_ < 0)
                    m &= (e_ > 0) | ((e_ == 0) & accb)
            if not m.any():
                empty[0] += 1
                e_n += 1
                e_area += ta
                e_list.append((ta, [round(float(c), 3) for c in (p[0] + p[1] + p[2]) / 3]))
                continue
            hit_loops.update(t.loops)
            iy, ix = np.nonzero(m)
            gy, gx = iy + y0, ix + x0
            newpos = (w0[m][:, None] * p[0] + w1[m][:, None] * p[1] + w2[m][:, None] * p[2])
            prev = cover[gy, gx] > 0
            dup = prev & (owner[gy, gx] == oi) & (np.linalg.norm(pos[gy, gx] - newpos, axis=1) < 1e-4)  # a texel centre exactly on a shared edge is hit by both triangles: the same point, not an overlap
            keep = ~dup
            gy, gx, newpos, prev = gy[keep], gx[keep], newpos[keep], prev[keep]
            if not len(gy):
                continue
            ov_self += int((prev & (owner[gy, gx] == oi)).sum())
            ov_cross += int((prev & (owner[gy, gx] != oi)).sum())
            cover[gy, gx] += 1
            pos[gy, gx] = newpos
            nrm[gy, gx] = n
            owner[gy, gx] = oi
        LASTHITS[oi] = (set(hit_loops), dict(loop_area))
        ec_n, ec_area, ec_list = 0, 0.0, []
        for it in charts_of.get(oi, []):
            if not any(l_ in hit_loops for _, l_ in it["ls"]):
                a_ = sum(loop_area.get(l_, 0.0) for _, l_ in it["ls"])
                ec_n += 1
                ec_area += a_
                ec_list.append((a_, it["ls"][0][1]))
        stats.append({"object": o.name, "faces": len(me.polygons), "triangles": len(me.loop_triangles), "area_m2": round(a3d, 4), "uv_area_fraction": round(a_uv, 4), "charts": CHARTS.get(oi, 0), "faces_per_chart": round(len(me.polygons) / max(CHARTS.get(oi, 0), 1), 2),
                      "mm_per_texel": round(math.sqrt(a3d / max(a_uv * atlas * atlas, 1e-12)) * 1000, 2), "scale": [round(c, 4) for c in o.scale], "overlap_within_object": ov_self, "overlap_with_other_objects": ov_cross,
                      "empty_charts": ec_n, "empty_charts_area_m2": round(ec_area, 4), "empty_charts_largest_cm2": [round(a * 1e4, 1) for a, _ in sorted(ec_list, key=lambda t: -t[0])[:3]], "no_texel_triangles": e_n, "no_texel_area_m2": round(e_area, 4), "no_texel_area_percent": round(100.0 * e_area / max(a3d, 1e-12), 2),
                      "no_texel_largest": [{"area_mm2": round(a * 1e6), "centre_m": c} for a, c in sorted(e_list, key=lambda t: -t[0])[:4]]})
    return cover, pos, nrm, owner, stats, empty[0]


def chart_maps(recv, atlas):
    """per atlas texel: the id of the chart that covers it (index in ITEMS, -1 = none; centre sampling, the inclusive rule like raster, last writer wins) and the LOCAL texel size in metres of its triangle (sqrt(3D area / UV area in texels))"""
    # chart ids: the packer's own charts (ITEMS). With weld_uv_only the packer worked on temporary welded copies, so each ORIGINAL loop is looked up through LOOPMAP (the welded loop its UV was copied from): exact, no matching by position
    item_of = {}
    for ci, it in enumerate(ITEMS):
        for oi_, l_ in it["ls"]:
            item_of[(oi_, l_)] = ci
    chart_of = {}
    first_loop = {}
    for oi, o in enumerate(recv):
        for l in range(len(o.data.loops)):
            ci = item_of.get(LOOPMAP.get((oi, l), (oi, l)), -1)
            chart_of[(oi, l)] = ci
            if ci >= 0 and ci not in first_loop:
                first_loop[ci] = (oi, l)
    base = len(ITEMS)
    for ci in range(base):
        first_loop.setdefault(ci, (0, 0))
    CHART_FIRST[:] = [first_loop[i] for i in range(base)]
    CHART_OF.clear()
    CHART_OF.update(chart_of)
    chart = np.full((atlas, atlas), -1, np.int32)
    scale = np.zeros((atlas, atlas))
    for oi, o in enumerate(recv):
        me = o.data
        me.calc_loop_triangles()
        uv = me.uv_layers[LM].data
        mw = o.matrix_world
        for t in me.loop_triangles:
            q = [np.array(uv[l].uv) * atlas for l in t.loops]
            den = (q[1][1] - q[2][1]) * (q[0][0] - q[2][0]) + (q[2][0] - q[1][0]) * (q[0][1] - q[2][1])
            if abs(den) < 1e-12:
                continue
            x0, x1 = int(max(0, math.floor(min(c[0] for c in q)))), int(min(atlas - 1, math.ceil(max(c[0] for c in q))))
            y0, y1 = int(max(0, math.floor(min(c[1] for c in q)))), int(min(atlas - 1, math.ceil(max(c[1] for c in q))))
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((q[1][1] - q[2][1]) * (xs - q[2][0]) + (q[2][0] - q[1][0]) * (ys - q[2][1])) / den
            w1 = ((q[2][1] - q[0][1]) * (xs - q[2][0]) + (q[0][0] - q[2][0]) * (ys - q[2][1])) / den
            m = (w0 >= 0) & (w1 >= 0) & ((1 - w0 - w1) >= 0)
            if not m.any():
                continue
            p3 = [np.array(mw @ me.vertices[v].co) for v in t.vertices]
            a3 = 0.5 * np.linalg.norm(np.cross(p3[1] - p3[0], p3[2] - p3[0]))
            iy, ix = np.nonzero(m)
            chart[iy + y0, ix + x0] = chart_of.get((oi, t.loops[0]), -1)
            scale[iy + y0, ix + x0] = math.sqrt(a3 / (abs(den) / 2.0))
    return chart, scale


def gutter_diagnostics(chart, pos, scale, info, dil, ref_m, max_rows=12):
    """REPORT-ONLY diagnostics next to the legacy `gutter_violations_2px` (which is kept unchanged). Inputs: chart id per texel (-1 = none), world position per texel, local texel size per texel (m), info(ci) -> {"receiver", ...} for a chart id, `dil` = the declared padding rings (dilate_px), `ref_m` = the legacy reference texel size.
    1. gutter_cross_chart_2px: covered texels that have a covered texel of ANOTHER chart within 2 texels (Chebyshev, the 5 x 5 window). A bilinear sample inside a covered texel reads a 2 x 2 footprint, all within 1 texel; a footprint texel that is another chart's texel, or a padding texel that is also next to another chart's texel (the padding is a mean of ALL covered neighbours), is contaminated: so, for a padding of at least 1 ring, contamination of the bilinear footprint <=> another chart's covered texel within 2 texels. `by_pair` lists the chart pairs, the nearest first.
    2. gutter_padding_overlap_texels: uncovered texels that lie within `dil` rings of covered texels of two or more different charts (the declared dilation then mixes their values there).
    3. gutter_stretch_2px: the legacy idea done per chart: two covered texels of the SAME chart within 2 texels whose 3D distance exceeds 1.6 x the local texel size (the larger of the two) x their Euclidean texel distance."""
    cov = chart >= 0
    H, W = chart.shape
    pairs = {}
    n_cross = np.zeros(chart.shape, bool)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if not (dx or dy):
                continue
            sh = np.roll(np.roll(chart, dy, 0), dx, 1)
            v = cov & (sh >= 0) & (sh != chart)
            if dy < 0 and dy != 0:
                v[dy:, :] = False
            elif dy > 0:
                v[:dy, :] = False
            if dx < 0:
                v[:, dx:] = False
            elif dx > 0:
                v[:, :dx] = False
            n_cross |= v
            if v.any():
                ys, xs = np.nonzero(v)
                a_ = chart[ys, xs].astype(np.int64)
                b_ = sh[ys, xs].astype(np.int64)
                lo_, hi_ = np.minimum(a_, b_), np.maximum(a_, b_)
                keys = lo_ * (1 << 20) + hi_
                cheb = max(abs(dx), abs(dy))
                uk, first, cnt = np.unique(keys, return_index=True, return_counts=True)
                for key, f_, c_ in zip(uk.tolist(), first.tolist(), cnt.tolist()):
                    kk = (key >> 20, key & ((1 << 20) - 1))
                    r = pairs.setdefault(kk, {"texel_offset_hits": 0, "nearest_chebyshev_texels": 9, "example": None})
                    r["texel_offset_hits"] += c_
                    if cheb < r["nearest_chebyshev_texels"]:
                        r["nearest_chebyshev_texels"] = cheb
                        r["example"] = {"texel_a": [int(xs[f_]), int(ys[f_])], "texel_b": [int(xs[f_] - dx), int(ys[f_] - dy)]}
    rows = []
    for (a, b), r in sorted(pairs.items(), key=lambda kv: (kv[1]["nearest_chebyshev_texels"], -kv[1]["texel_offset_hits"]))[:max_rows]:
        rows.append({"chart_a": a, "chart_b": b, "receiver_a": info(a).get("receiver"), "receiver_b": info(b).get("receiver"), "first_polygon_a": info(a).get("first_polygon"), "first_polygon_b": info(b).get("first_polygon"), **r})
    # padding overlap: charts within `dil` rings (3 x 3 min / max of the chart id, dil times)
    BIG = 1 << 30
    mn = np.where(cov, chart, BIG).astype(np.int64)
    mx = np.where(cov, chart, -1).astype(np.int64)
    for _ in range(max(0, int(dil))):
        a1 = mn.copy()
        b1 = mx.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx or dy:
                    a1 = np.minimum(a1, np.roll(np.roll(mn, dy, 0), dx, 1))
                    b1 = np.maximum(b1, np.roll(np.roll(mx, dy, 0), dx, 1))
        mn, mx = a1, b1
    overlap = (~cov) & (mx >= 0) & (mn != mx)
    # stretch (same chart, Euclidean, local texel size)
    stretch = np.zeros(chart.shape, bool)
    ex = []
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if not (dx or dy):
                continue
            sh = np.roll(np.roll(chart, dy, 0), dx, 1)
            shp = np.roll(np.roll(pos, dy, 0), dx, 1)
            shs = np.roll(np.roll(scale, dy, 0), dx, 1)
            d3 = np.linalg.norm(shp - pos, axis=2)
            lim = 1.6 * np.maximum(scale, shs) * math.hypot(dx, dy)
            v = cov & (sh == chart) & (d3 > lim + 1e-9)
            if dy < 0:
                v[dy:, :] = False
            elif dy > 0:
                v[:dy, :] = False
            if dx < 0:
                v[:, dx:] = False
            elif dx > 0:
                v[:, :dx] = False
            if v.any() and len(ex) < max_rows:
                ys, xs = np.nonzero(v)
                k = int(np.argmax((d3 / np.maximum(lim, 1e-12))[v]))
                ex.append({"chart": int(chart[ys[k], xs[k]]), "receiver": info(int(chart[ys[k], xs[k]])).get("receiver"), "texel": [int(xs[k]), int(ys[k])], "offset": [dx, dy],
                           "distance_mm": round(float(d3[ys[k], xs[k]]) * 1000, 2), "allowed_mm": round(float(lim[ys[k], xs[k]]) * 1000, 2)})
            stretch |= v
    worst = []
    if stretch.any():
        ids, cnts = np.unique(chart[stretch], return_counts=True)
        for ci_, cn_ in sorted(zip(ids.tolist(), cnts.tolist()), key=lambda t: -t[1])[:max_rows]:
            worst.append({"chart": ci_, "receiver": info(ci_).get("receiver"), "first_polygon": info(ci_).get("first_polygon"), "texels": cn_})
    return {"gutter_stretch_worst_charts": worst, "gutter_cross_chart_2px": int(n_cross.sum()), "gutter_cross_chart_pairs": len(pairs), "gutter_cross_chart_nearest": rows,
            "gutter_padding_overlap_texels": int(overlap.sum()), "gutter_padding_rings_declared": int(dil),
            "gutter_stretch_2px": int(stretch.sum()), "gutter_stretch_examples": ex,
            "gutter_diagnostics_note": "report-only; gutter_padding_overlap_texels counts texels within the declared rings of two charts: with the first-come dilation each is still owned by one chart, but the other chart's padding is then shorter than declared (it matters for wider-than-bilinear filters and mip levels); gutter_violations_2px is the legacy count and is unchanged. A bilinear sample reads a 2 x 2 footprint (all within 1 texel): with at least 1 padding ring it is contaminated exactly when another chart's covered texel lies within 2 texels (gutter_cross_chart_2px); with the declared padding rings, texels near two charts are mixed (gutter_padding_overlap_texels); gutter_stretch_2px is the same-chart distance test against the LOCAL texel size and the Euclidean texel distance."}


def dilate(val, cov, n):
    """fill uncovered texels next to covered ones with the mean of their covered neighbours, n times (the baker's own EXTEND margin overwrote covered texels, so it is off); returns the filled array"""
    v = val.copy()
    c = cov.copy()
    for _ in range(n):
        acc = np.zeros_like(v)
        cnt = np.zeros(v.shape, np.int32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx or dy:
                    acc += np.roll(np.roll(np.where(c, v, 0.0), dy, 0), dx, 1)
                    cnt += np.roll(np.roll(c, dy, 0), dx, 1).astype(np.int32)
        new = (~c) & (cnt > 0)
        v = np.where(new, acc / np.maximum(cnt, 1), v)
        c = c | new
    return v, c


def probes_for(bo, recv, cover, pos, nrm, owner, val, atlas, caster_names, dmin, interior1, n_max):
    """PHYSICAL check at sampled receiver points, separate from the UV/export check: for random covered texels (one texel in from any island edge) a ray to the bulb says whether the point is truly unobstructed (only `casters` block; diffuser shells and non-casters are stepped through); then the stored value is compared with cos/max(d,d_min)^2 for the visible ones, and the blocked ones should be dark"""
    scn = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    rng = np.random.default_rng(1)
    ys, xs = np.nonzero(interior1)
    if len(ys) == 0:
        return {"tested": 0}
    pick_ = rng.choice(len(ys), size=min(n_max, len(ys)), replace=False)
    lp = bo.matrix_world.translation
    rows = []

    def blocker(origin_pt, nrm_v):
        """the caster that blocks the ray from this point to the light, or None; the ray is AIMED from its own (lifted) origin: aiming from the surface point instead shifts the ray by a couple of millimetres at the far end, enough to slip past a thin plate"""
        org = origin_pt + nrm_v * 2e-3
        dv_ = lp - org
        d_ = dv_.length
        dir_ = dv_ / d_
        left = d_
        for _ in range(12):
            hit, loc, hn, idx, ob, mw = scn.ray_cast(dg, org, dir_, distance=left)
            if not hit:
                return None
            if ob.name in caster_names:
                return ob.name
            step = (loc - org).length + 1e-4
            org = loc + dir_ * 1e-4
            left -= step
            if left <= 0:
                return None
        return None
    for k in pick_:
        y, x = int(ys[k]), int(xs[k])
        p = Vector(pos[y, x])
        n = Vector(nrm[y, x])
        dv = lp - p
        d = dv.length
        if d < 1e-6:
            continue
        facing = n.dot(dv) / d
        if facing <= 1e-3:
            continue
        # the texel is a patch, not a point: the centre and the four edge midpoints (towards the neighbouring texels, which interior1 guarantees lie on the same surface)
        pts = [p] + [(p + Vector(pos[y + dy, x + dx])) / 2 for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0))]
        bl = [blocker(q, n) for q in pts]
        nb = sum(1 for b_ in bl if b_ is not None)
        state = "visible" if nb == 0 else ("blocked" if nb == len(bl) else "edge")
        ana = facing / max(d, dmin) ** 2
        rows.append({"object": recv[int(owner[y, x])].name, "world_m": [round(float(c), 3) for c in p], "normal": [round(float(c), 3) for c in n], "texel": [x, y], "dist_m": round(d, 3), "cos": round(float(facing), 3),
                     "state": state, "blocked_by": next((b_ for b_ in bl if b_ is not None), None), "rays_blocked_of_5": nb, "expected": float(ana), "stored": float(val[y, x]), "ratio": float(val[y, x] / ana) if ana > 0 else None})
    vis = [r for r in rows if r["state"] == "visible"]
    blk = [r for r in rows if r["state"] == "blocked"]
    edge = [r for r in rows if r["state"] == "edge"]
    rat = np.array([r["ratio"] for r in vis if r["ratio"] is not None and r["cos"] > 0.2])
    out = {"tested": len(rows), "visible": len(vis), "blocked": len(blk), "shadow_edge_texels": len(edge), "edge_note": "texels whose five rays (centre and four edge midpoints) disagree: partly shadowed, any stored value between 0 and open air is right; not counted in visible or blocked", "visible_facing_cos_gt_0.2": int(len(rat))}
    if len(rat):
        out["visible_ratio_p10_p50_p90"] = [round(float(np.percentile(rat, q)), 3) for q in (10, 50, 90)]
        out["visible_within_10_percent"] = int(((rat > 0.9) & (rat < 1.1)).sum())
        out["visible_stored_zero"] = int((rat < 1e-6).sum())
    out["blocked_dark"] = int(sum(1 for r in blk if r["stored"] < 0.1 * r["expected"])) if blk else 0
    vs = sorted([r for r in vis if r["cos"] > 0.2], key=lambda r: -r["expected"])
    pickv = [vs[i] for i in np.linspace(0, len(vs) - 1, min(10, len(vs))).astype(int)] if vs else []
    out["samples_visible"] = [{k_: (round(v_, 5) if isinstance(v_, float) else v_) for k_, v_ in r.items()} for r in pickv]
    out["samples_blocked"] = [{k_: (round(v_, 5) if isinstance(v_, float) else v_) for k_, v_ in r.items()} for r in blk[:4]]
    return out


def lights_state():
    return {o.name: (o.data.energy, o.data.use_shadow) for o in bpy.context.scene.objects if o.type == "LIGHT"}


def bake_image(recv, img, samples, bake_margin=4):
    """bake DIFFUSE direct into `img` (a float image), the targets given by a temporary image node in each receiver material"""
    scn = bpy.context.scene
    # every receiver is baked with ONE temporary white Diffuse material, so the result is the light itself (no albedo, no specular layer): the originals are put back afterwards
    tmp = bpy.data.materials.new("lm_white")
    tmp.use_nodes = True
    nt = tmp.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    dif = nt.nodes.new("ShaderNodeBsdfDiffuse")
    dif.inputs["Color"].default_value = (1, 1, 1, 1)
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
    bpy.ops.object.select_all(action="DESELECT")
    for o in recv:
        o.select_set(True)
    bpy.context.view_layer.objects.active = recv[0]
    ren0 = {}
    for o in recv:  # the bake reads the render-active UV layer: make it the lightmap layer for the bake, then put the first layer back
        lay = o.data.uv_layers.get(LM)
        if lay is not None:
            ren0[o] = next(u for u in o.data.uv_layers if u.active_render)
            lay.active_render = True
            o.data.uv_layers.active = lay
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = False
    try:
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, margin=bake_margin, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES")
    finally:
        for o, lay0 in ren0.items():
            lay0.active_render = True
        for o, mats in undo:
            if mats is None:
                o.data.materials.clear()
            else:
                for sl, m in zip(o.material_slots, mats):
                    sl.material = m
        bpy.data.materials.remove(tmp)


def calibrate(samples, radius):
    """a white plane 1 m under a light of the bulbs' radius, far from the scene: raw bake value x d^2 = the factor from Cycles' raw output to the contract (per the energy E0)"""
    scn = bpy.context.scene
    st0 = lights_state()  # only the calibration light and a black world: the scene's own lights and world must not add to the reading
    z0 = -2000.0
    me = bpy.data.meshes.new("lm_cal")
    me.from_pydata([(-2, -2, z0), (2, -2, z0), (2, 2, z0), (-2, 2, z0)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UVMap")
    for li, c in zip(me.polygons[0].loop_indices, ((0, 0), (1, 0), (1, 1), (0, 1))):
        uv.data[li].uv = c
    plane = bpy.data.objects.new("lm_cal", me)
    scn.collection.objects.link(plane)
    ld = bpy.data.lights.new("lm_cal", "POINT")
    ld.energy, ld.shadow_soft_size, ld.use_shadow = E0, radius, True
    lo = bpy.data.objects.new("lm_cal", ld)
    scn.collection.objects.link(lo)
    lo.location = (0, 0, z0 + 1.0)
    img = bpy.data.images.new("lm_cal", 64, 64, alpha=False, float_buffer=True, is_data=True)
    world0 = scn.world
    w = bpy.data.worlds.new("lm_black")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    scn.world = w
    for ln in st0:
        bpy.data.objects[ln].data.energy = 0.0
    try:
        bake_image([plane], img, samples)
        a = np.array(img.pixels[:], np.float64).reshape(64, 64, 4)[:, :, 0]
        c = (np.arange(64) + 0.5) * (4.0 / 64) - 2.0  # texel centres across the 4 m plane
        gx, gy = np.meshgrid(c[26:38], c[26:38])
        v = float(a[26:38, 26:38].sum() / (1.0 / (1.0 + gx ** 2 + gy ** 2) ** 1.5).sum())  # raw per unit of cos/d^2: the patch is not exactly under the light, so divide by its analytic sum
    finally:
        for ln, (e, sh) in st0.items():
            bpy.data.objects[ln].data.energy = e
        scn.world = world0
        bpy.data.worlds.remove(w)
        bpy.data.objects.remove(plane, do_unlink=True)
        bpy.data.objects.remove(lo, do_unlink=True)
        bpy.data.meshes.remove(me)
        bpy.data.lights.remove(ld)
        bpy.data.images.remove(img)
    if v <= 0:
        raise RuntimeError("calibration bake returned 0")
    return v * 1.0 ** 2, v


def main():
    dry = bool(L.param("dry_run", False))
    atlas = int(L.param("atlas_px", 512))
    margin = int(L.param("margin_px", 8))
    if int(L.param("dilate_px", 4)) < 2 or margin < 2:
        raise RuntimeError("v1.1 needs at least 2 texels of gutter (margin_px) and of dilated padding (dilate_px)")
    samples = int(L.param("samples", 128))
    name = str(L.param("name", "lightmaps"))
    scn = bpy.context.scene
    recv = pick(L.param("receivers") or [], {"MESH"})
    if not recv:
        raise RuntimeError("give receivers")
    bad = [o.name for o in recv if is_animated(o)]
    if bad:
        raise RuntimeError(f"refused: animated meshes cannot be receivers: {bad}")
    bulbs = []
    for b in L.param("bulbs") or []:
        if any(c in b for c in "*?"):
            g = b
        elif f"bulb_{b}.light" in bpy.data.objects:
            g = f"bulb_{b}.light"
        else:
            g = b  # an exact light object name (a bare emitter from emitters_make): the map id is the name
        bulbs += [o for o in pick([g], {"LIGHT"}) if o not in bulbs]
    names_before = sorted(o.name for o in scn.objects)
    # CASTERS are separate from receivers: every visible mesh that blocks light, minus `exclude_casters` (default the bulb diffuser shells: a point source sits inside its own bulb)
    excl = L.param("exclude_casters", ["bulb_*.diffuser"])
    allm = [o for o in scn.objects if o.type == "MESH" and "blender_agent_marker" not in o and not o.hide_render]
    forced_off = [o for o in allm if o.visible_shadow and any(fnmatch.fnmatchcase(o.name, g) for g in excl)]
    casters = [o for o in allm if o.visible_shadow and o not in forced_off]
    caster_rep = {"count": len(casters), "names": sorted(o.name for o in casters)[:400], "excluded_from_casting": sorted(o.name for o in forced_off)[:400], "excluded_count": len(forced_off),
                  "receivers_that_also_cast": sorted(o.name for o in recv if o in casters), "animated_casters_pose_dependent": sorted(o.name for o in casters if is_animated(o))[:100],
                  "not_casting_already": sorted(o.name for o in allm if not o.visible_shadow)[:100], "rule": "a mesh casts when it is render-visible and its Ray Visibility > Shadow is on, except the names in exclude_casters (switched off for the bake and put back)"}
    warn = []
    for o in recv:
        if any(abs(c - 1) > 1e-6 for c in o.scale):
            warn.append(f"{o.name}: scale {tuple(round(c, 3) for c in o.scale)} is not 1; texel density may differ between receivers")
    PACKER[0] = L.param("packer", "shelf")
    TIE_RULE[0] = L.param("tie_rule", "inclusive")
    if TIE_RULE[0] not in ("inclusive", "top_left_b", "top_left_b_f32"):
        raise RuntimeError('tie_rule must be "inclusive", "top_left_b" or "top_left_b_f32"')
    SPLITOV[0] = bool(L.param("split_uv_overlaps", False))
    SPARSE[:] = [({"objects": r} if isinstance(r, str) else r) for r in (L.param("split_sparse_charts") or [])]
    MINPX[0] = float(L.param("min_chart_px", 0))
    make_uvs(recv, atlas, margin, L.param("density"), float(L.param("angle_limit_deg", 66)), float(L.param("weld_m", 0)), bool(L.param("weld_uv_only", False)))
    fold_rows = collapse_folded_polygons(recv, float(L.param("collapse_folded_polygons", 0))) if L.param("collapse_folded_polygons") is not None else None
    cover, pos, nrm, owner, stats, empty_tris = raster(recv, atlas)
    mm = [s["mm_per_texel"] for s in stats]
    layout = {"atlas_px": atlas, "margin_px": margin, "coverage_percent": round(float((cover > 0).mean()) * 100, 2), "overlap_texels": int((cover > 1).sum()),
              "mm_per_texel_min": min(mm), "mm_per_texel_max": max(mm), "charts_total": sum(CHARTS.values()), "tie_rule": TIE_RULE[0], "split_sparse_charts": dict(SPARSE_REP), "split_uv_overlaps": {"requested": SPLITOV[0], "receivers_changed": len(SPLIT), "polygon_pairs": sum(v["overlapping_polygon_pairs"] for v in SPLIT.values()), "polygons_moved": sum(v["polygons_moved"] for v in SPLIT.values()), "by_receiver": dict(list(SPLIT.items())[:20])}, "texel_centres_exactly_on_a_triangle_edge": TIES[0], "empty_charts_total": sum(x["empty_charts"] for x in stats), "empty_charts_area_m2": round(sum(x["empty_charts_area_m2"] for x in stats), 4), "empty_charts_by_receiver": {x["object"]: [x["empty_charts"], x["empty_charts_area_m2"]] for x in stats if x["empty_charts"]}, "pack": dict(PACK), "weld_m": float(L.param("weld_m", 0)), "vertices_welded_away": sum(a - b for a, b in WELDED.values()), "weld_uv_only": bool(L.param("weld_uv_only", False)), "weld_uv_transfer": {"receivers": len(TRANSFER), "all_ok": all(r["ok"] for r in TRANSFER.values()) if TRANSFER else None, "max_position_error_m": max([r["max_position_error_m"] for r in TRANSFER.values()] or [0]), "mismatch_loops": sum(r["mismatch_loops"] for r in TRANSFER.values())}, "angle_limit_deg": float(L.param("angle_limit_deg", 66))}
    # gutters: no texel of another island within 2 texels (a covered neighbour that is NOT on the same surface patch means the gap between islands is under 2 texels)
    tex_m0 = max(mm) / 1000.0
    covb0 = cover > 0
    viol = np.zeros(covb0.shape, bool)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx or dy:
                shp = np.roll(np.roll(pos, dy, 0), dx, 1)
                shc = np.roll(np.roll(covb0, dy, 0), dx, 1)
                viol |= covb0 & shc & (np.linalg.norm(shp - pos, axis=2) > tex_m0 * max(abs(dx), abs(dy)) * 1.6 + 1e-9)
    layout["gutter_violations_2px"] = int(viol.sum())
    if fold_rows is not None:
        by_r = {}
        for r_ in fold_rows:
            b_ = by_r.setdefault(r_["receiver"], {"found": 0, "collapsed": 0, "collapsed_area_m2": 0.0, "largest_collapsed_m2": 0.0})
            b_["found"] += 1
            if r_["collapsed"]:
                b_["collapsed"] += 1
                b_["collapsed_area_m2"] += r_["area_m2"]
                b_["largest_collapsed_m2"] = max(b_["largest_collapsed_m2"], r_["area_m2"])
        for b_ in by_r.values():
            b_["collapsed_area_m2"] = round(b_["collapsed_area_m2"], 10)
        full_path = os.path.join(L.ARGS["out_dir"], f"{name}-folded-polygons.json")
        os.makedirs(L.ARGS["out_dir"], exist_ok=True)
        with open(full_path, "w", encoding="utf-8") as fh_:
            json.dump(fold_rows, fh_)
        layout["folded_polygons"] = {"threshold_m2": float(L.param("collapse_folded_polygons")), "found": len(fold_rows), "collapsed": sum(1 for r in fold_rows if r["collapsed"]),
                                     "collapsed_area_m2_total": round(sum(r["area_m2"] for r in fold_rows if r["collapsed"]), 10), "largest_collapsed_m2": max([r["area_m2"] for r in fold_rows if r["collapsed"]] or [0.0]),
                                     "left_alone_area_m2_total": round(sum(r["area_m2"] for r in fold_rows if not r["collapsed"]), 6), "by_receiver": by_r, "full_list_file": full_path, "rows": fold_rows[:40],
                                     "note": "polygons whose own triangles overlap in the LightmapUV; the collapsed ones got one UV point (LightmapUV only); the others are listed and left as they are"}
    try:
        chart_id, chart_scale = chart_maps(recv, atlas)
        polys_of = {oi: np.array([p.loop_start for p in o.data.polygons]) for oi, o in enumerate(recv)}

        def chart_info(ci):
            oi, l0 = CHART_FIRST[ci]
            return {"receiver": recv[oi].name, "first_polygon": int(np.searchsorted(polys_of[oi], l0, side="right") - 1)}
        layout.update(gutter_diagnostics(chart_id, pos, chart_scale, chart_info, int(L.param("dilate_px", 4)), tex_m0))
    except Exception as e:  # noqa: BLE001 - diagnostics must never stop the layout
        layout["gutter_diagnostics_error"] = f"{type(e).__name__}: {e}"
    if viol.any():
        warn.append(f"{int(viol.sum())} texels have another island within 2 texels: raise margin_px or atlas_px")
    layout["triangles_with_no_texel_centre"] = empty_tris
    if empty_tris:
        warn.append(f"{empty_tris} receiver triangles cover no texel centre at this atlas size (too small: no value is stored for them)")
    if layout["overlap_texels"]:
        warn.append(f"{layout['overlap_texels']} atlas texels are covered by more than one face")
    if max(mm) > 4 * min(mm):
        warn.append("texel density differs more than 4x between receivers")
    rep_maps, files, cal, manifest = [], [], None, []
    out_lm = os.path.join(L.ARGS["out_dir"], "lightmaps")
    dmin = float(L.param("distance_min_m", 0.1))
    radius = float(L.param("bake_light_radius_m", 0.0))  # contract v1.1: a point emitter of radius 0 (hard shadows)
    if bulbs:
        k, raw = calibrate(samples, radius)
        cal = {"light_radius_m": round(radius, 4), "distance_m": 1.0, "raw_value": raw, "factor_raw_to_contract": k, "energy_w": E0, "samples": samples}
    if bulbs and not dry:
        os.makedirs(out_lm, exist_ok=True)
        st0 = lights_state()
        world0 = scn.world
        w = bpy.data.worlds.new("lm_black")
        w.use_nodes = True
        w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
        scn.world = w
        eng0 = scn.render.engine
        sumimg = np.zeros((atlas, atlas), np.float64)
        packed = []
        stored_c = []
        for o in forced_off:
            o.visible_shadow = False
        radii0 = {n: bpy.data.objects[n].data.shadow_soft_size for n in st0}
        for n in st0:
            bpy.data.objects[n].data.shadow_soft_size = radius
        cov0 = cover > 0
        caster_names = {o.name for o in casters}
        interior1 = cov0.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                shp1 = np.roll(np.roll(pos, dy, 0), dx, 1)
                interior1 &= np.roll(np.roll(cov0, dy, 0), dx, 1) & (np.linalg.norm(shp1 - pos, axis=2) <= max(s["mm_per_texel"] for s in stats) / 1000.0 * max(abs(dx), abs(dy)) * 1.6 + 1e-9)
        tex_m = max(s["mm_per_texel"] for s in stats) / 1000.0
        interior = cov0.copy()
        for dy in range(-3, 4):  # 3 texels in from every island edge: the bake's margin and pixel filter bleed up to there
            for dx in range(-3, 4):
                sh = np.roll(np.roll(cov0, dy, 0), dx, 1)
                shp = np.roll(np.roll(pos, dy, 0), dx, 1)
                shn = np.roll(np.roll(nrm, dy, 0), dx, 1)
                # a true neighbour lies on the same surface within a texel or two: another island packed next to this one (even with the same normal) is not
                interior &= sh & ((shn * nrm).sum(axis=2) > 0.999) & (np.linalg.norm(shp - pos, axis=2) <= tex_m * max(abs(dx), abs(dy)) * 1.6 + 1e-9)
        zero_on = L.param("zero_on") or {}
        try:
            for bo in bulbs:
                for ln, (e, sh) in st0.items():
                    d = bpy.data.objects[ln].data
                    d.energy, d.use_shadow = (E0, True) if ln == bo.name else (0.0, sh)
                img = bpy.data.images.new("lm_map", atlas, atlas, alpha=False, float_buffer=True, is_data=True)
                bake_image(recv, img, samples, int(L.param("bake_margin_px", 0)))
                raw_a = np.array(img.pixels[:], np.float64).reshape(atlas, atlas, 4)[:, :, 0]
                val = raw_a / k
                cov = cover > 0
                val = np.where(cov, val, 0.0)
                zrep = None
                zspec = zero_on.get(bo.name) or zero_on.get(bo.name[len("bulb_"):-len(".light")] if bo.name.startswith("bulb_") and bo.name.endswith(".light") else bo.name)
                if zspec:
                    zrep = {}
                    for g in zspec:
                        idx = [i for i, r_ in enumerate(recv) if fnmatch.fnmatchcase(r_.name, g)]
                        if not idx:
                            raise RuntimeError(f"zero_on {bo.name}: '{g}' matches no receiver")
                        m_ = np.isin(owner, idx) & cov
                        for i in idx:
                            mi = (owner == i) & cov
                            zrep[recv[i].name] = {"texels_zeroed": int(mi.sum()), "of_which_lit_before": int((val[mi] > 1e-4).sum())}
                        val = np.where(m_, 0.0, val)
                lp = np.array(bo.matrix_world.translation)
                dv = lp - pos
                dist = np.linalg.norm(dv, axis=2)
                ana = np.where(cov & (dist > 1e-6), np.maximum(0.0, (dv * nrm).sum(axis=2) / np.maximum(dist, 1e-9)) / np.maximum(dist, 1e-9) ** 2, 0.0)
                facing = interior & (ana > 1e-6)  # interior texels only: at an island or face edge the bake's pixel sample spills over
                ratio = np.where(facing, val / np.maximum(ana, 1e-12), 0.0)
                bad = np.argwhere((ratio > 1.05) & (ana > 0.01 * float(ana.max())))
                worst = [{"texel": [int(x), int(y)], "object": recv[int(owner[y, x])].name, "pos_m": [round(float(c), 3) for c in pos[y, x]], "normal": [round(float(c), 3) for c in nrm[y, x]], "dist_m": round(float(dist[y, x]), 3),
                          "analytic": round(float(ana[y, x]), 4), "baked": round(float(val[y, x]), 4), "cover_row": cover[y, max(0, x - 3):x + 4].tolist(), "cover_col": cover[max(0, y - 3):y + 4, x].tolist(), "val_row": [round(float(c), 3) for c in val[y, max(0, x - 3):x + 4]], "ana_row": [round(float(c), 3) for c in ana[y, max(0, x - 3):x + 4]]} for y, x in bad[np.argsort(-ratio[tuple(bad.T)])[:6]]] if len(bad) else []
                bid = bo.name[len("bulb_"):-len(".light")] if bo.name.startswith("bulb_") and bo.name.endswith(".light") else bo.name
                fn = f"{name}-{bid}.exr"
                out = bpy.data.images.new("lm_out", atlas, atlas, alpha=False, float_buffer=True, is_data=True)
                px = np.zeros((atlas, atlas, 4), np.float32)
                clampm = cov & (dist < dmin)
                valc = np.where(clampm, val * (dist / dmin) ** 2, val)  # contract v1.1: 1/d^2 is taken at d >= distance_min_m
                vald, cfin = dilate(valc, cov, int(L.param("dilate_px", 4)))
                probe_rep = probes_for(bo, recv, cover, pos, nrm, owner, valc, atlas, caster_names, dmin, interior1, int(L.param("probes", 600)))
                px[:, :, 0] = px[:, :, 1] = px[:, :, 2] = vald
                px[:, :, 3] = 1.0
                out.pixels.foreach_set(px.ravel())
                s0 = scn.render.image_settings
                fmt0 = (s0.file_format, s0.color_mode, s0.color_depth)
                s0.file_format, s0.color_mode, s0.color_depth, s0.exr_codec = "OPEN_EXR", "BW", "16", "ZIP"
                out.save_render(os.path.join(out_lm, fn), scene=scn)
                s0.file_format, s0.color_mode, s0.color_depth = fmt0  # put back: the pictures below must be PNG, not EXR
                bpy.data.images.remove(out)
                bpy.data.images.remove(img)
                sumimg += vald
                packed.append(vald)
                stored_c.append(valc)
                rep_maps.append({"bulb": bid, "light": bo.name, "zero_on": zrep, "file": "lightmaps/" + fn, "position_m": [round(c, 4) for c in lp], "contract_max": round(float(valc.max()), 4), "clamped_texels": int(clampm.sum()), "lit_percent_of_covered": round(float((val[cov] > 1e-4).mean()) * 100, 2),
                                 "worst_texels": worst, "probes": probe_rep, "checks": {"interior_texels": int(interior.sum()), "ratio_p10_p50_p90": [round(float(np.percentile(ratio[facing], q)), 3) for q in (10, 50, 90)] if facing.any() else None, "facing_texels": int(facing.sum()), "ratio_max": round(float(np.where(ana > 0.01 * float(ana.max()), ratio, 0).max()), 3), "within_5_percent": int(((ratio > 0.95) & (ratio < 1.05)).sum()), "shadowed_below_half": int(((ratio < 0.5) & facing).sum()),
                                            "brighter_than_open_air_5_percent": int(((ratio > 1.05) & (ana > 0.01 * float(ana.max()))).sum())}})
                manifest.append({"bulb": bid, "light": bo.name, "file": fn, "position_m": [round(c, 4) for c in lp], "clamped_texels": int(clampm.sum())})
        finally:
            for ln, (e, sh) in st0.items():
                d = bpy.data.objects[ln].data
                d.energy, d.use_shadow = e, sh
            for o in forced_off:
                o.visible_shadow = True
            for n, r0 in radii0.items():
                bpy.data.objects[n].data.shadow_soft_size = r0
            scn.world = world0
            bpy.data.worlds.remove(w)
            scn.render.engine = eng0
        import hashlib
        # CORRESPONDENCE probes for verb 85: exact points (texel centres one texel in from any island edge, a spread over every receiver) with the values stored for every bulb; no physics involved
        rng2 = np.random.default_rng(7)
        pys, pxs = np.nonzero(interior1)
        probes_out = []
        per_obj = {}
        for k_ in rng2.permutation(len(pys)):
            y_, x_ = int(pys[k_]), int(pxs[k_])
            oi_ = int(owner[y_, x_])
            if per_obj.get(oi_, 0) >= 12 or len(probes_out) >= 400:
                continue
            per_obj[oi_] = per_obj.get(oi_, 0) + 1
            probes_out.append({"object": recv[oi_].name, "world_m": [round(float(c), 6) for c in pos[y_, x_]], "normal": [round(float(c), 6) for c in nrm[y_, x_]], "texel": [x_, y_],
                               "uv1_gltf": [(x_ + 0.5) / atlas, 1.0 - (y_ + 0.5) / atlas], "values": {manifest[i]["bulb"]: float(np.float16(stored_c[i][y_, x_])) for i in range(len(stored_c))}})
        with open(os.path.join(out_lm, f"{name}.probes.json"), "w", encoding="utf-8") as f:
            json.dump({"note": "world_m is in the Blender frame; uv1_gltf is the exported TEXCOORD_1 of the texel centre; values are the half-float values stored in the bin for that texel", "probes": probes_out}, f)
        layers = (len(packed) + 3) // 4
        arr = np.zeros((layers, atlas, atlas, 4), np.float16)
        for i, v in enumerate(packed):
            arr[i // 4, :, :, i % 4] = np.flipud(v).astype(np.float16)  # row 0 = the TOP of the image = glTF v 0 (Blender's own row 0 is its bottom)
        binb = arr.astype("<f2").tobytes()
        with open(os.path.join(out_lm, f"{name}.lightmaps.bin"), "wb") as f:
            f.write(binb)
        label = np.where(cover > 0, 1, np.where(cfin, 2, 0)).astype(np.uint8)
        covb = np.flipud(label).tobytes()
        with open(os.path.join(out_lm, f"{name}.mask.u8"), "wb") as f:
            f.write(covb)
        for i, mm_ in enumerate(manifest):
            mm_["layer"], mm_["channel"] = i // 4, i % 4
        pack = {"file": f"{name}.lightmaps.bin", "bytes": len(binb), "sha256": hashlib.sha256(binb).hexdigest(), "format": "little-endian IEEE half float RGBA, linear, layer-major, row-major, texel, channel; layer k channel c = fixture 4k+c, unused channels 0",
                "layers": layers, "width": atlas, "height": atlas, "row0": "the TOP of the image = glTF TEXCOORD_1 v = 0 (flipY false)", "scale": 1.0, "expected_bytes": layers * atlas * atlas * 8,
                "probe_file": f"{name}.probes.json", "mask_file": f"{name}.mask.u8", "mask_bytes": len(covb), "mask_sha256": hashlib.sha256(covb).hexdigest(), "mask": "ONE w*h uint8 plane, same row order as the bin: 0 = not receiver, 1 = true receiver (a face covers the texel centre), 2 = island padding (dilated response, NOT coverage)",
                "padding": f"{int(L.param('dilate_px', 4))} texels dilated from covered texels (mean of covered neighbours); further texels 0", "contract_version": "1.1", "distance_min_m": dmin, "distance_cutoff_m": 0, "decay": 2, "emitter_radius_m": radius, "pose": "fixed: the checkpoint as saved", "scale_applied_to_stored": 1.0}
        with open(os.path.join(out_lm, f"{name}.lightmaps.json"), "w", encoding="utf-8") as f:
            json.dump({"name": name, "atlas_px": atlas, "uv_layer": LM, "gltf_texcoord": 1, "format": "OpenEXR half float, single channel (R=G=B)", "origin": "texel (0,0) is the bottom-left of the image, v = y / atlas",
                       "value": "illuminance of one bulb of intensity 1 cd: cos(theta)/d^2 (1/m^2), 0 in shadow; direct only, no albedo, no ambient, no bounce",
                       "runtime": "radiance = albedo / pi x sum_i(I_i(R,G,B) x map_i)", "pose": "the checkpoint's rest pose (static set as saved)",
                       "receivers": [{"object": s["object"], "mm_per_texel": s["mm_per_texel"]} for s in stats], "maps": manifest, "calibration": cal, "pack": pack,
                       "glb_binding": "bind to the exported GLB by node names above and its sha256 (fill in after export_scene: the GLB does not exist yet when this step runs)"}, f, indent=2)
        # pictures: the atlas sum and a top view of the receivers lit by the sum of the maps
        views = L.param("views", ["maps", "atlas"])
        res = int(L.param("res", 800))
        nz = sumimg[sumimg > 1e-6]
        top = float(np.percentile(nz, 99)) if len(nz) else 1.0  # 99th percentile, not the maximum: one hot texel next to a bulb must not turn the rest black
        gam = np.clip(sumimg / max(top, 1e-9), 0, 1) ** 0.5
        pimg = bpy.data.images.new("lm_prev", atlas, atlas, alpha=False)
        prgb = np.zeros((atlas, atlas, 4), np.float32)
        prgb[:, :, 0] = prgb[:, :, 1] = prgb[:, :, 2] = gam
        prgb[:, :, 3] = 1
        pimg.pixels.foreach_set(prgb.ravel())
        pimg.update()
        pimg.pack()  # a generated image only reaches the Workbench render once it is updated and packed
        if "atlas" in views:
            p = os.path.join(L.ARGS["out_dir"], f"{name}-atlas.png")
            pimg.filepath_raw = p
            pimg.file_format = "PNG"
            pimg.save()
            files.append(p)
        if "maps" in views:
            # our own picture (a generated texture does not show in the Workbench render): every covered texel is drawn at its world position, seen from above (top) and from the front (front, looking along +Y);
            # the nearer surface wins; grey = sqrt(sum of all maps / its 99th percentile); red dots = the bulbs
            def splat(proj, depth_sign, tag, ptsb):
                cov_ = cover > 0
                ys_, xs_ = np.nonzero(cov_)
                P_ = pos[ys_, xs_]
                v_ = gam[ys_, xs_]
                u2 = P_[:, proj[0]]
                v2 = P_[:, proj[1]]
                dep = P_[:, proj[2]] * depth_sign
                lo_u, hi_u, lo_v, hi_v = u2.min(), u2.max(), v2.min(), v2.max()
                span = max(hi_u - lo_u, hi_v - lo_v, 1e-6) * 1.04
                ppm = res / span
                img_ = np.full((res, res, 4), (0.55, 0.57, 0.63, 1.0), np.float32)
                order = np.argsort(dep)
                px_ = ((u2[order] - lo_u + (span - (hi_u - lo_u)) / 2) * ppm).astype(int)
                py_ = ((v2[order] - lo_v + (span - (hi_v - lo_v)) / 2) * ppm).astype(int)
                rad = max(1, int(round(0.5 * (max(mm) / 1000.0) * ppm)))
                for dy_ in range(-rad, rad + 1):
                    for dx_ in range(-rad, rad + 1):
                        xx = np.clip(px_ + dx_, 0, res - 1)
                        yy = np.clip(py_ + dy_, 0, res - 1)
                        img_[yy, xx, :3] = v_[order][:, None]
                for bp in ptsb:
                    cx_ = int((bp[proj[0]] - lo_u + (span - (hi_u - lo_u)) / 2) * ppm)
                    cy_ = int((bp[proj[1]] - lo_v + (span - (hi_v - lo_v)) / 2) * ppm)
                    if 0 <= cx_ < res and 0 <= cy_ < res:
                        img_[max(cy_ - 3, 0):cy_ + 4, max(cx_ - 3, 0):cx_ + 4, :3] = (1.0, 0.1, 0.1)
                im2 = bpy.data.images.new("lm_splat", res, res, alpha=False)
                im2.pixels.foreach_set(img_.ravel())
                fp = os.path.join(L.ARGS["out_dir"], f"{name}-maps-{tag}.png")
                im2.filepath_raw = fp
                im2.file_format = "PNG"
                im2.save()
                bpy.data.images.remove(im2)
                return fp
            bpts = [tuple(bo_.matrix_world.translation) for bo_ in bulbs]
            files.append(splat((0, 1, 2), 1, "top", bpts))
            files.append(splat((0, 2, 1), -1, "front", bpts))
        bpy.data.images.remove(pimg)
    # the layout picture (always, also in a dry run): colour per receiver, true texels bright, padding dim, nothing black
    cov_l = cover > 0
    _, pad_l = dilate(np.zeros((atlas, atlas)), cov_l, int(L.param("dilate_px", 4)))
    lay = np.zeros((atlas, atlas, 4), np.float32)
    lay[:, :, 3] = 1.0
    import colorsys
    for oi in range(len(recv)):
        r_, g_, b_ = colorsys.hsv_to_rgb((oi * 0.173) % 1.0, 0.75, 1.0)
        lay[cov_l & (owner == oi), :3] = (r_, g_, b_)
    lay[pad_l & ~cov_l, :3] = (0.22, 0.22, 0.30)
    limg = bpy.data.images.new("lm_layout", atlas, atlas, alpha=False)
    limg.pixels.foreach_set(lay.ravel())
    lp_ = os.path.join(L.ARGS["out_dir"], f"{name}-layout.png")
    limg.filepath_raw = lp_
    limg.file_format = "PNG"
    limg.save()
    bpy.data.images.remove(limg)
    files.append(lp_)
    layout["picture"] = {"file": os.path.basename(lp_), "legend": "one colour per receiver (order of `receivers` in layout), dim blue-grey = padding (mask 2), black = unused; row 0 is the bottom of the picture as Blender shows it"}
    layout["no_texel_total"] = {"triangles": empty_tris, "area_m2": round(sum(s_["no_texel_area_m2"] for s_ in stats), 4), "of_receiver_area_m2": round(sum(s_["area_m2"] for s_ in stats), 3)}
    pg_ = L.param("pose_globs", ["Louver_*", "Louvers_*"])
    pobj = [o for o in scn.objects if any(fnmatch.fnmatchcase(o.name, g) for g in pg_)]
    angs = {}
    for o in pobj:
        k = tuple(round(math.degrees(c), 1) for c in o.rotation_euler)
        angs[k] = angs.get(k, 0) + 1
    tracks = []
    for o in scn.objects:
        ad = o.animation_data
        if ad and (ad.nla_tracks or ad.action):
            tracks.append({"object": o.name, "action": ad.action.name if ad.action else None, "nla": [{"track": t.name, "muted": bool(t.mute)} for t in ad.nla_tracks]})
    pose_rep = {"matched_objects": len(pobj), "rotation_euler_deg_unique": [{"deg": list(k), "objects": v} for k, v in sorted(angs.items())],
                "frame_current": scn.frame_current, "animated_objects": len(tracks), "unmuted_nla_tracks": sum(1 for t in tracks for n_ in t["nla"] if not n_["muted"]),
                "active_actions": sum(1 for t in tracks if t["action"]), "first_animated": tracks[:6],
                "note": "the bake sees the saved rest pose: rotation_euler as listed, no clip evaluated unless an action is assigned or an NLA track is unmuted at frame_current"}
    for o in recv:
        o.data.uv_layers.active_index = 0
    changed = sorted(set(o.name for o in scn.objects) ^ set(names_before))
    layout["receivers"] = stats
    L.finish(f"{'dry run: ' if dry else ''}{len(recv)} receivers unwrapped, {len(rep_maps)} maps baked", save=not dry, layout=layout, pose_as_saved=pose_rep, casters=caster_rep, calibration=cal, maps=rep_maps, warnings=warn, objects_added_or_removed=changed, files=files,
             uv_layers={o.name: [u.name for u in o.data.uv_layers] for o in recv}, contract="see the docstring: value = cos(theta)/d^2 per 1 cd; direct only; shadows from the static set; no albedo/ambient/bounce", dry_run=dry)


if __name__ == "__main__":  # importable by lightmap_recheck without running
    L.run(main)
