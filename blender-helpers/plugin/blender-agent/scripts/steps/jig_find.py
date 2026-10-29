"""jig_find — find the JIG on a generated part: the saturated-blue region the generator drew where this part joins another (a neck stump, a wrist disc), by colour in the part's albedo seen through its UVs; fit its shape and report where it is, which way it faces, how big it is and how that compares with the size you expect. Saves a checkpoint (the result is kept on the part as the property jig_<id>, for `seat`), or reads only with dry_run.

How: each face is sampled in the base-colour image (the part's material, through the active UV layer or `uv`) at its centre and three points inside it; a face is BLUE when the median of its four colour distances to `jig_rgb` is at most `jig_tol`. Blue faces form regions (connected by shared edges, seam-split vertices counted as one); the LARGEST region is the jig; the others are listed with their sizes. The region is fitted as
  disc     a flat face, round: centre, axis (the face's normal, pointing OUT of the part), diameter
  ellipse  a flat face with two unequal radii: major and minor diameters and the major axis direction
  stump    a short cylinder with a flat top (not flat): axis (pointing out), radius, the top plane's centre, the base centre and the height
chosen by the fit: flat when the region's thickness along its normal is under `flat_ratio` (default 0.2) of its diameter, else a stump.

params:
  part       the object (required)
  id         a name for this jig (default "jig"): the result is stored on the part as property jig_<id>; run it again with the same id to replace it
  jig_rgb    [r, g, b] sRGB 0-255 (default [40, 120, 245]); jig_tol the colour distance (default 60)
  jig_mm     the size you expect, millimetres: a diameter, or [major, minor] for an ellipse; gives scale_factor = jig_mm / measured (the major for an ellipse)
  uv         the UV layer (default the active one); image: the name of the image to sample (default the base-colour image of the part's first material that has one)
  min_faces  a region smaller than this is not a jig (default 30)
  flat_ratio see above (default 0.2)
  dry_run    true: report and picture only, store and save nothing
  pictures   true (default): the part in clay with the jig faces in magenta, from the axis and from the side; res px (default 600)
Returns: found (true / false), regions (faces, area_mm2, centre_mm of each), jig: kind, centre_mm (world, the face centre; for a stump the top's centre), axis (unit, pointing out of the part), diameter_mm | major_mm / minor_mm (+ major_axis), height_mm (stump), plane_rms_mm (how far the blue faces sit from the fitted plane or cylinder: large = the blue bled), bleed_pct (blue faces whose normal is more than 20 degrees off the axis, for a flat jig), faces, area_mm2, scale_factor, colour_distance (median of the jig faces), the image used, pictures, notes.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
from _handview import render_views  # noqa: E402


def find_image(obj, want):
    if want:
        im = bpy.data.images.get(want)
        if im is None:
            raise RuntimeError(f"no image named {want}")
        return im
    for m in obj.data.materials:
        if m is None or not m.use_nodes:
            continue
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is not None and bsdf.inputs["Base Color"].links:
            n = bsdf.inputs["Base Color"].links[0].from_node
            seen = 0
            while n is not None and n.type != "TEX_IMAGE" and seen < 6:
                ins = [i for i in n.inputs if i.links]
                n = ins[0].links[0].from_node if ins else None
                seen += 1
            if n is not None and n.type == "TEX_IMAGE" and n.image:
                return n.image
    for m in obj.data.materials:
        if m is not None and m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image:
                    return n.image
    raise RuntimeError("the part's materials have no image texture (the jig is found by its colour in the albedo)")


def bilinear(img, u, v):
    h, w = img.shape[:2]
    x = np.clip(u * w - 0.5, 0, w - 1.001)
    y = np.clip(v * h - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    return img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy


def main():
    obj = bpy.data.objects.get(L.param("part", ""))
    if obj is None or obj.type != "MESH":
        raise RuntimeError("give `part`: a mesh object")
    me = obj.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None or uvn not in me.uv_layers:
        raise RuntimeError(f"no such UV layer; the layers are {[u.name for u in me.uv_layers]}")
    im = find_image(obj, L.param("image"))
    w_, h_ = im.size
    px = np.empty(w_ * h_ * 4, np.float32)
    im.pixels.foreach_get(px)
    img = px.reshape(h_, w_, 4)[..., :3] * 255.0  # rows from the bottom (v = 0), values as stored
    jrgb = np.array(L.param("jig_rgb", [40, 120, 245]), float)
    tol = float(L.param("jig_tol", 60))
    mw = np.array(obj.matrix_world)
    me.calc_loop_triangles()
    uvl = np.empty(len(me.loops) * 2)
    me.uv_layers[uvn].data.foreach_get("uv", uvl)
    uvl = uvl.reshape(-1, 2)
    P = np.array([list(v.co) for v in me.vertices]) @ mw[:3, :3].T + mw[:3, 3]
    nf = len(me.polygons)
    dist = np.zeros(nf)
    fcol = np.zeros((nf, 3))
    fc = np.zeros((nf, 3))
    fa = np.zeros(nf)
    fn = np.zeros((nf, 3))
    for p in me.polygons:
        li = list(p.loop_indices)
        uv = uvl[li]
        c = uv.mean(0)
        pts = [c] + [c + (u - c) * 0.6 for u in uv[:3]]
        cols = np.array([bilinear(img, np.array([q[0] % 1.0]), np.array([q[1] % 1.0]))[0] for q in pts])
        dist[p.index] = float(np.median(np.linalg.norm(cols - jrgb, axis=1)))
        fcol[p.index] = cols[0]
        vs = np.array([P[i] for i in p.vertices])
        fc[p.index] = vs.mean(0)
        fa[p.index] = p.area * abs(np.linalg.det(mw[:3, :3])) ** (2 / 3)
        nn = mw[:3, :3] @ np.array(p.normal)
        fn[p.index] = nn / max(np.linalg.norm(nn), 1e-12)
    blue = dist <= tol
    minf = int(L.param("min_faces", 30))
    # regions: faces joined by shared edges, vertices identified by position (seam splits)
    key = {}
    vid = np.zeros(len(me.vertices), int)
    for i, v in enumerate(P):
        vid[i] = key.setdefault(tuple(np.round(v, 5)), len(key))
    parent = list(range(nf))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    emap = {}
    for p in me.polygons:
        if not blue[p.index]:
            continue
        vs = [vid[i] for i in p.vertices]
        for k in range(len(vs)):
            e = tuple(sorted((vs[k], vs[(k + 1) % len(vs)])))
            if e in emap:
                a, b = find(p.index), find(emap[e])
                if a != b:
                    parent[a] = b
            else:
                emap[e] = p.index
    comps = {}
    for i in np.nonzero(blue)[0]:
        comps.setdefault(find(int(i)), []).append(int(i))
    regions = sorted(comps.values(), key=lambda r: -fa[r].sum())
    out = {"part": obj.name, "id": L.param("id", "jig"), "image": im.name, "image_size": [w_, h_], "uv": uvn, "jig_rgb": list(jrgb), "jig_tol": tol, "blue_faces": int(blue.sum()), "image_mean_rgb": [round(float(x), 1) for x in img.reshape(-1, 3).mean(0)], "image_max_rgb": [round(float(x), 1) for x in img.reshape(-1, 3).max(0)], "closest_face_colour_rgb": [round(float(x), 1) for x in fcol[int(np.argmin(dist))]],
           "regions": [{"faces": len(r), "area_mm2": round(float(fa[r].sum()) * 1e6, 1), "centre_mm": [round(float(x) * 1000, 1) for x in fc[r].mean(0)]} for r in regions[:8]], "dry_run": bool(L.param("dry_run", False))}
    if not regions or len(regions[0]) < minf:
        out["found"] = False
        out["notes"] = [f"no blue region of at least {minf} faces: check jig_rgb / jig_tol against the albedo (the closest face is {round(float(dist.min()), 1)} away from jig_rgb)"]
        L.finish(out, save=False)
        return
    R = np.array(regions[0])
    w = fa[R]
    cen = (fc[R] * w[:, None]).sum(0) / w.sum()
    cov = ((fc[R] - cen).T * w) @ (fc[R] - cen) / w.sum()
    ev, evec = np.linalg.eigh(cov)  # ascending
    n_plane = evec[:, 0]
    mean_n = (fn[R] * w[:, None]).sum(0)
    if np.dot(n_plane, mean_n) < 0:
        n_plane = -n_plane
    d_pl = (fc[R] - cen) @ n_plane
    rms = float(np.sqrt((w * d_pl ** 2).sum() / w.sum()))
    # extent of the region's vertices in the plane / along the normal
    vi = sorted({v for i in R for v in me.polygons[i].vertices})
    Vv = P[vi]
    a1, a2 = evec[:, 2], evec[:, 1]
    t_ext = float(np.ptp((Vv - cen) @ n_plane))
    e1 = np.ptp((Vv - cen) @ a1)
    e2 = np.ptp((Vv - cen) @ a2)
    dmaj = float(max(e1, e2))
    flat_ratio = float(L.param("flat_ratio", 0.2))
    jig = {}
    if t_ext <= flat_ratio * dmaj:
        # a flat face: the area-weighted variance of a filled ellipse is r^2 / 4 on each axis, so the radii come from the spread, the extents are reported next to them
        s1, s2 = float(np.sqrt(w @ (((fc[R] - cen) @ a1) ** 2) / w.sum())), float(np.sqrt(w @ (((fc[R] - cen) @ a2) ** 2) / w.sum()))
        major_axis = a1 if s1 >= s2 else a2
        ext_major, ext_minor = (e1, e2) if s1 >= s2 else (e2, e1)  # the outline's own extent along the principal axes of the region: the diameters
        ra, rb = ext_major / 2, ext_minor / 2
        kind = "disc" if (ra - rb) / max(ra, 1e-9) < 0.08 else "ellipse"
        dev = np.degrees(np.arccos(np.clip(fn[R] @ n_plane, -1, 1)))
        jig = {"kind": kind, "centre_mm": [round(float(x) * 1000, 2) for x in cen], "axis": [round(float(x), 4) for x in n_plane], "plane_rms_mm": round(rms * 1000, 3), "bleed_pct": round(float((dev > 20).mean() * 100), 1)}
        if kind == "disc":
            jig["diameter_mm"] = round(float(ra + rb) * 1000, 2)
        else:
            jig["major_mm"], jig["minor_mm"] = round(2 * ra * 1000, 2), round(2 * rb * 1000, 2)
            jig["major_axis"] = [round(float(x), 4) for x in major_axis]
        measured = (ra + rb) if kind == "disc" else 2 * ra
        jig["extent_mm"] = {"along_a1": round(float(e1) * 1000, 2), "along_a2": round(float(e2) * 1000, 2), "thickness": round(t_ext * 1000, 2)}
    else:
        # a stump: choose the axis (one of the three principal directions) whose cross-section is the roundest
        best = None
        for k in range(3):
            ax = evec[:, k]
            q = Vv - Vv.mean(0)
            q = q - np.outer(q @ ax, ax)
            b1 = np.linalg.svd(q, full_matrices=False)[2][:2]
            xy = q @ b1.T
            cx = xy.mean(0)
            r = np.linalg.norm(xy - cx, axis=1)
            r = r[r > 0.5 * r.max()]  # the outline ring (a fan's centre vertex is not on it)
            roundness = float(r.std() / max(r.mean(), 1e-9))
            if best is None or roundness < best[0]:
                best = (roundness, k, float(r.mean()), cx, b1)
        _, k, rad, cx, b1 = best
        ax = evec[:, k]
        pr = (Vv - cen) @ ax
        sg = float(((fn[R] @ ax) * w).sum())  # the flat top dominates this sum (the side faces are square to the axis)
        top_dir = (1.0 if sg >= 0 else -1.0) if abs(sg) > 1e-3 * float(w.sum()) else (1.0 if np.dot(ax, cen - P.mean(0)) >= 0 else -1.0)
        axis = ax * top_dir
        pr = (Vv - cen) @ axis
        top_c = cen + axis * pr.max()
        base_c = cen + axis * pr.min()
        qq = (Vv - Vv.mean(0))
        qq = qq - np.outer(qq @ axis, axis)
        radial = np.linalg.norm(qq - (qq.mean(0)), axis=1)
        radial = radial[radial > 0.5 * radial.max()]
        rad = float(np.median(radial))
        jig = {"kind": "stump", "centre_mm": [round(float(x) * 1000, 2) for x in top_c], "top_centre_mm": [round(float(x) * 1000, 2) for x in top_c], "base_centre_mm": [round(float(x) * 1000, 2) for x in base_c],
               "axis": [round(float(x), 4) for x in axis], "diameter_mm": round(float(2 * rad) * 1000, 2), "height_mm": round(float(pr.max() - pr.min()) * 1000, 2), "plane_rms_mm": round(float(radial.std()) * 1000, 3), "roundness": round(float(best[0]), 3)}
        measured = 2 * rad
        top_f = [i for i in R if abs(float(fn[i] @ axis)) > 0.8]
        jig["top_faces"] = len(top_f)
    jig["faces"] = int(len(R))
    jig["area_mm2"] = round(float(fa[R].sum()) * 1e6, 1)
    jig["colour_distance"] = round(float(np.median(dist[R])), 1)
    jm = L.param("jig_mm")
    if jm is not None:
        j0 = float(jm[0] if isinstance(jm, list) else jm)
        mm = measured * 1000 if jig["kind"] != "ellipse" else jig["major_mm"]
        jig["scale_factor"] = round(j0 / max(mm, 1e-9), 4)
        jig["expected_mm"] = jm
    out["found"] = True
    out["jig"] = jig
    files = []
    if L.param("pictures", True):
        res = int(L.param("res", 600))
        old = [p.material_index for p in me.polygons]
        mat = bpy.data.materials.get("jig-highlight") or bpy.data.materials.new("jig-highlight")
        mat.diffuse_color = (1.0, 0.0, 0.8, 1.0)
        me.materials.append(mat)
        mi = len(me.materials) - 1
        for i in R:
            me.polygons[i].material_index = mi
        ax_v = Vector(jig["axis"])
        side = ax_v.cross(Vector((0, 0, 1)))
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        size = max(float(dmaj) * 3.0, 0.08)
        files = render_views([obj], Vector(cen.tolist()), size, "jig-" + str(L.param("id", "jig")), res, {"on_axis": ax_v, "side": side.normalized(), "above": Vector((0.001, 0.001, 1.0)) if abs(ax_v.z) < 0.9 else Vector((0.001, 1, 0.3))})
        for p, mi0 in zip(me.polygons, old):
            p.material_index = mi0
        me.materials.pop()
        out["pictures"] = [os.path.basename(f) for f in files]
    if not L.param("dry_run", False):
        obj["jig_" + str(L.param("id", "jig"))] = json.dumps(jig)
    out["notes"] = ["the jig is found by colour in the albedo through the UVs: keep the generator's UVs until this has run", "axis points OUT of the part; centre is in world millimetres", "plane_rms_mm large or bleed_pct high: the blue bled onto the surrounding surface: lower jig_tol or inspect the picture"]
    L.finish(out, save=not L.param("dry_run", False), files=files)


L.run(main)
