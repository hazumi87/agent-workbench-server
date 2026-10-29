"""face_trim — cut CHOSEN faces along the edges of the faces that cover them and delete only the sub-faces that are fully covered; the uncovered strips stay. For a PARTIAL overlap (a sheet 97 % under another, with end strips beside it) where `face_remove` would lose visible area. Saves a checkpoint (not with dry_run).

You choose the faces; the covering faces come from this mesh's unchosen faces and the objects in `cover_by`. Nothing else changes: every unchosen face keeps its positions, material, UV and corner normals (proved).
params:
  part        the object (required); a mesh shared with another object, with shape keys or with modifiers is refused
  select      `{"faces": [indices]}` or filters ANDed: `components`, `box` (WORLD metres, centres inside), `plane` ({"point","normal","dist_tol_m","angle_tol_deg","either_side"}), as in `face_remove`
  cover_by    OTHER objects (names / globs) whose faces also cover (evaluated, world)
  cover_dist_m  default 0.0005, cover_angle_deg default 1, cover_facing "same" (default) | "any": as in `face_remove`
  dry_run     true: the plan only (planes, sub-face counts, areas), nothing is changed
  expect      {"faces": n} (chosen) and/or {"removed_faces": n, "removed_area_m2": a, "area_tol_m2": 1e-5}: nothing changes when the numbers differ
  name        file stem of the full list (default face_trim)
How it works: for each chosen face the covering polygons that lie on its plane (within cover_dist_m, parallel within cover_angle_deg, the facing rule) and overlap its bounding box are found; each of their edges gives a cutting plane (perpendicular to the sheet through that edge); the chosen face is cut by all of them (UVs interpolated by the cut). Every sub-face is then tested with the `face_remove` proof (7 samples per triangle against the unchosen faces and `cover_by`); sub-faces with ALL samples covered are removed, the others stay.
Returns: `chosen_faces`, `planes_cut`, `subfaces`, `removed_subfaces` / `kept_subfaces`, `removed_area_m2`, `kept_area_m2` (their sum = the chosen faces' area before: `area_conserved`), `kept_examples` (centre, area, bounds), `uv_area_conserved` (per chosen face: the UV area of its sub-faces over its UV area before; 1.0 = no UV lost or invented), counts before / after, `survivors_identical` (every face that is NOT a sub-face of a chosen one has the same world positions, material, smooth flag, UV-at-corner pairs: multiset proof), `custom_normals`.
Custom normals: a chosen face whose corner normals are all equal (flat) gives every sub-face that same normal; a chosen face with differing corner normals is REFUSED (interpolating them is a guess), the others keep their corner normals exactly (compared before and after).
Limits: the cutting planes come from the covering faces' own edges, so a partial overlap bounded by edges of the cover is cut cleanly; coverage is point-sampled (7 per triangle); a chosen face that no covering face touches is left whole; very many cutting planes per face are refused (limit 64).
"""
import fnmatch
import hashlib
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402


def pieces(bm):
    comp_of = {}
    n = 0
    for v in bm.verts:
        if v.index in comp_of or not v.link_faces:
            continue
        stack = [v]
        comp_of[v.index] = n
        while stack:
            a = stack.pop()
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in comp_of:
                    comp_of[b.index] = n
                    stack.append(b)
        n += 1
    return comp_of, n


def signatures(bm, mw, only=None):
    """per face: world ring, material, smooth flag, UV pairs. Corners that only sit on a straight edge (a vertex a neighbour's cut left on this face's edge) are dropped, so a cut next to a face does not count as changing it."""
    out = {}
    uvl = list(bm.loops.layers.uv.values())
    for f in bm.faces:
        if only is not None and not only(f):
            continue
        pts = [np.array(mw @ lp.vert.co) for lp in f.loops]
        uvs = [tuple((layer.name, round(lp[layer].uv.x, 6), round(lp[layer].uv.y, 6)) for layer in uvl) for lp in f.loops]
        keepi = []
        n = len(pts)
        for i in range(n):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
            if np.linalg.norm(np.cross(b - a, c - b)) < 1e-9 and np.dot(b - a, c - b) > 0:
                continue
            keepi.append(i)
        pr = [tuple(round(float(x), 6) for x in pts[i]) for i in keepi]
        ur = [uvs[i] for i in keepi]
        k = min(range(len(pr)), key=lambda i: pr[i])
        key = (tuple(pr[k:] + pr[:k]), f.material_index, tuple(ur[k:] + ur[:k]), f.smooth)
        out[key] = out.get(key, 0) + 1
    return out


def world_area(f, mw):
    """area in WORLD square metres (a bmesh face's own area is in object space and ignores the object's scale)"""
    pts = [mw @ v.co for v in f.verts]
    s = Vector((0.0, 0.0, 0.0))
    for i in range(len(pts)):
        s += pts[i].cross(pts[(i + 1) % len(pts)])
    return s.length / 2.0


def uv_area(f, layer):
    uv = [lp[layer].uv.copy() for lp in f.loops]
    s = 0.0
    for i in range(len(uv)):
        a, b = uv[i], uv[(i + 1) % len(uv)]
        s += a.x * b.y - b.x * a.y
    return abs(s) / 2.0


def main():
    ob = bpy.data.objects.get(L.param("part", ""))
    if ob is None or ob.type != "MESH":
        raise RuntimeError(f"part: no mesh object named {L.param('part')!r}")
    me = ob.data
    if me.users > 1:
        raise RuntimeError(f"{ob.name}: the mesh is shared by {me.users} users; refusing")
    if me.shape_keys is not None:
        raise RuntimeError(f"{ob.name}: has shape keys; refusing")
    if len(ob.modifiers):
        raise RuntimeError(f"{ob.name}: has modifiers; refusing")
    had_custom = bool(me.has_custom_normals)
    sel = L.param("select") or {}
    dry = bool(L.param("dry_run", False))
    mw = ob.matrix_world.copy()
    mwi = mw.inverted()
    M3 = np.array(mw)[:3, :3]
    M3it = np.linalg.inv(M3).T
    mt = np.array(mw)[:3, 3]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    nf = len(bm.faces)
    if "faces" in sel:
        chosen = sorted({int(i) for i in sel["faces"]})
        bad = [i for i in chosen if not 0 <= i < nf]
        if bad:
            raise RuntimeError(f"select.faces: {bad[:5]} outside 0..{nf - 1}")
    else:
        if not any(k in sel for k in ("components", "box", "plane")):
            raise RuntimeError("select: give faces, or components / box / plane")
        keep = np.ones(nf, dtype=bool)
        comp_of, ncomp = pieces(bm)
        if "components" in sel:
            want = {int(i) for i in sel["components"]}
            keep &= np.array([comp_of[bm.faces[i].verts[0].index] in want for i in range(nf)])
        cen = np.array([(M3 @ np.array(bm.faces[i].calc_center_median())) + mt for i in range(nf)])
        if "box" in sel:
            lo, hi = np.array(sel["box"][0], dtype=float), np.array(sel["box"][1], dtype=float)
            keep &= ((cen >= lo) & (cen <= hi)).all(axis=1)
        if "plane" in sel:
            pl = sel["plane"]
            pn = np.array(pl["normal"], dtype=float)
            pn /= np.linalg.norm(pn)
            pp = np.array(pl["point"], dtype=float)
            dt = float(pl.get("dist_tol_m", 0.002))
            at = math.cos(math.radians(float(pl.get("angle_tol_deg", 2.0))))
            fn = np.array([M3it @ np.array(bm.faces[i].normal) for i in range(nf)])
            fn /= np.maximum(np.linalg.norm(fn, axis=1), 1e-30)[:, None]
            dots = fn @ pn
            okn = (np.abs(dots) >= at) if pl.get("either_side", True) else (dots >= at)
            keep &= (np.abs((cen - pp) @ pn) <= dt) & okn
        chosen = [int(i) for i in np.nonzero(keep)[0]]
    if not chosen:
        raise RuntimeError("nothing chosen")
    cset = set(chosen)
    if len(cset) == nf:
        raise RuntimeError("the selection is the whole mesh; refusing")
    exp = L.param("expect") or {}
    if "faces" in exp and exp["faces"] != len(chosen):
        raise RuntimeError(f"expect {exp['faces']} faces but {len(chosen)} chosen: nothing changed")
    dist_tol = float(L.param("cover_dist_m", 0.0005))
    cos_t = math.cos(math.radians(float(L.param("cover_angle_deg", 1.0))))
    facing = L.param("cover_facing", "same")
    if facing not in ("same", "any"):
        raise RuntimeError("cover_facing: same | any")
    # ---- custom normals of the chosen faces must be uniform
    cn_before = None
    chosen_normal = {}
    if had_custom:
        cn = np.empty(len(me.loops) * 3)
        me.corner_normals.foreach_get("vector", cn)
        cn = cn.reshape(-1, 3)
        cn_before = {p.index: cn[p.loop_start:p.loop_start + p.loop_total].copy() for p in me.polygons}
        for i in chosen:
            c = cn_before[i]
            ref = c[0] / max(np.linalg.norm(c[0]), 1e-30)
            devs = np.degrees(np.arccos(np.clip((c / np.maximum(np.linalg.norm(c, axis=1), 1e-30)[:, None]) @ ref, -1, 1)))
            if devs.max() > 0.05:
                raise RuntimeError(f"face {i}: its corner normals differ (up to {devs.max():.2f} degrees); interpolating them would be a guess: refusing")
            chosen_normal[i] = tuple(ref)
    # ---- covering polygons (world): unchosen faces of this mesh + cover_by objects
    cover_polys = []  # (list of world Vector corners, world normal)
    sv, st, snorm = [], [], []
    idx = {}
    for f in bm.faces:
        if f.index in cset:
            continue
        ids = []
        for v in f.verts:
            if v.index not in idx:
                idx[v.index] = len(sv)
                sv.append(mw @ v.co)
            ids.append(idx[v.index])
        fn = Vector(M3it @ np.array(f.normal)).normalized()
        for k in range(1, len(ids) - 1):
            st.append((ids[0], ids[k], ids[k + 1]))
            snorm.append(fn)
        cover_polys.append(([mw @ v.co for v in f.verts], fn))
    cb = L.param("cover_by") or []
    if isinstance(cb, str):
        cb = [cb]
    dg = bpy.context.evaluated_depsgraph_get()
    for o in [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name != ob.name and any(fnmatch.fnmatchcase(o.name, g) for g in cb)]:
        ev = o.evaluated_get(dg)
        m2 = ev.to_mesh()
        try:
            w2 = ev.matrix_world
            A3it = np.linalg.inv(np.array(w2)[:3, :3]).T
            base = len(sv)
            sv.extend(w2 @ v.co for v in m2.vertices)
            m2.calc_loop_triangles()
            for t in m2.loop_triangles:
                st.append((base + t.vertices[0], base + t.vertices[1], base + t.vertices[2]))
                snorm.append(Vector(A3it @ np.array(t.normal)).normalized())
            for p in m2.polygons:
                cover_polys.append(([sv[base + vi] for vi in p.vertices], Vector(A3it @ np.array(p.normal)).normalized()))
        finally:
            ev.to_mesh_clear()
    bvh = BVHTree.FromPolygons(sv, st, all_triangles=True) if st else None
    # ---- cutting planes per chosen face
    planes = {}
    for fi in chosen:
        f = bm.faces[fi]
        n = Vector(M3it @ np.array(f.normal)).normalized()
        fv = [mw @ v.co for v in f.verts]
        lo = Vector((min(p.x for p in fv), min(p.y for p in fv), min(p.z for p in fv))) - Vector((dist_tol,) * 3)
        hi = Vector((max(p.x for p in fv), max(p.y for p in fv), max(p.z for p in fv))) + Vector((dist_tol,) * 3)
        d0 = n.dot(fv[0])
        lst = []
        for pts, pn_ in cover_polys:
            dt_ = pn_.dot(n)
            if abs(dt_) < cos_t or (dt_ < 0 and facing == "same"):
                continue
            if any(abs(n.dot(p) - d0) > dist_tol for p in pts):
                continue
            if max(p.x for p in pts) < lo.x or min(p.x for p in pts) > hi.x or max(p.y for p in pts) < lo.y or min(p.y for p in pts) > hi.y or max(p.z for p in pts) < lo.z or min(p.z for p in pts) > hi.z:
                continue
            for a in range(len(pts)):
                p0, p1 = pts[a], pts[(a + 1) % len(pts)]
                e = (p1 - p0)
                if e.length < 1e-7:
                    continue
                pl_n = e.cross(n)
                if pl_n.length < 1e-9:
                    continue
                pl_n.normalize()
                if (pl_n.x, pl_n.y, pl_n.z) < (0, 0, 0):
                    pl_n = -pl_n
                key = (round(pl_n.x, 5), round(pl_n.y, 5), round(pl_n.z, 5), round(pl_n.dot(p0), 5))
                lst.append((key, p0.copy(), pl_n.copy()))
        uniq = {}
        for key, p0, pn_ in lst:
            uniq.setdefault(key, (p0, pn_))
        # keep only planes that really cut through the face
        cuts = []
        for key, (p0, pn_) in uniq.items():
            ds = [pn_.dot(p - p0) for p in fv]
            if min(ds) < -1e-6 and max(ds) > 1e-6:
                cuts.append((p0, pn_))
        if len(cuts) > 64:
            raise RuntimeError(f"face {fi}: {len(cuts)} cutting planes (limit 64): narrow the cover")
        planes[fi] = cuts
    n_planes = sum(len(v) for v in planes.values())
    area_before = sum(world_area(bm.faces[i], mw) for i in chosen)
    comp_of, ncomp = pieces(bm)
    uvl = bm.loops.layers.uv.values()
    uv0 = {}
    if uvl:
        for i in chosen:
            uv0[i] = uv_area(bm.faces[i], uvl[0])
    counts_before = (len(bm.verts), len(bm.faces))
    sig_before = signatures(bm, mw, only=lambda f: f.index not in cset)
    other_before = {i: (cn_before[i].copy() if had_custom else None) for i in range(nf) if i not in cset} if had_custom else None
    # ---- tag layers and cut
    lay_orig = bm.faces.layers.int.new("ft_orig")
    lay_tag = bm.faces.layers.int.new("ft_tag")
    for f in bm.faces:
        f[lay_orig] = f.index
        f[lay_tag] = 1 if f.index in cset else 0
    for fi in chosen:
        for p0, pn_ in planes[fi]:
            geom_f = [f for f in bm.faces if f[lay_tag] == 1 and f[lay_orig] == fi]
            geom = list(geom_f)
            geom += [e for f in geom_f for e in f.edges]
            geom += [v for f in geom_f for v in f.verts]
            geom = list(dict.fromkeys(geom))
            pl_co = mwi @ p0
            pl_no = Vector(M3.T @ np.array(pn_)).normalized()
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-7, plane_co=pl_co, plane_no=pl_no)
    bm.faces.ensure_lookup_table()
    subs = [f for f in bm.faces if f[lay_tag] == 1]
    # ---- coverage of every sub-face
    bw = [(1 / 3, 1 / 3, 1 / 3), (0.8, 0.1, 0.1), (0.1, 0.8, 0.1), (0.1, 0.1, 0.8), (0.45, 0.45, 0.1), (0.1, 0.45, 0.45), (0.45, 0.1, 0.45)]
    removed, kept = [], []
    for f in subs:
        n = Vector(M3it @ np.array(f.normal)).normalized()
        vs = [mw @ v.co for v in f.verts]
        ok_all = True
        for k in range(1, len(vs) - 1):
            tri = (vs[0], vs[k], vs[k + 1])
            for a, b, c in bw:
                p = tri[0] * a + tri[1] * b + tri[2] * c
                hit_ok = False
                if bvh is not None:
                    for sg in (1.0, -1.0):
                        o = p + n * (sg * dist_tol * 2.0)
                        loc, hn, hi_, dd = bvh.ray_cast(o, -n * sg, dist_tol * 4.0)
                        if loc is None:
                            continue
                        dot = snorm[hi_].dot(n)
                        if abs(dot) >= cos_t and abs((loc - p).dot(n)) <= dist_tol and (dot > 0 or facing == "any"):
                            hit_ok = True
                if not hit_ok:
                    ok_all = False
                    break
            if not ok_all:
                break
        (removed if ok_all else kept).append(f)
    rem_area = sum(world_area(f, mw) for f in removed)
    kept_area = sum(world_area(f, mw) for f in kept)
    ex = L.param("expect") or {}
    if "removed_faces" in ex and ex["removed_faces"] != len(removed):
        raise RuntimeError(f"expect {ex['removed_faces']} removed sub-faces but {len(removed)}: nothing changed")
    if "removed_area_m2" in ex and abs(ex["removed_area_m2"] - rem_area) > float(ex.get("area_tol_m2", 1e-5)):
        raise RuntimeError(f"expect removed area {ex['removed_area_m2']} but {rem_area:.6f}: nothing changed")
    kept_examples = [{"centre_m": [round(x, 4) for x in (mw @ f.calc_center_median())], "area_m2": round(world_area(f, mw), 6),
                      "bounds_m": [[round(min((mw @ v.co)[a] for v in f.verts), 4) for a in range(3)], [round(max((mw @ v.co)[a] for v in f.verts), 4) for a in range(3)]]} for f in kept[:12]]
    uv_ratio = None
    if uvl:
        uv_ratio = {}
        for i in chosen:
            tot = sum(uv_area(f, uvl[0]) for f in subs if f[lay_orig] == i)
            uv_ratio[i] = round(tot / uv0[i], 6) if uv0.get(i) else None
    identical = None
    custom_report = {"custom_normals": False}
    after_counts = None
    if not dry:
        bmesh.ops.delete(bm, geom=removed, context="FACES")
        bm.to_mesh(me)
        me.update()
        bm2 = bmesh.new()
        bm2.from_mesh(me)
        bm2.faces.ensure_lookup_table()
        lo2 = bm2.faces.layers.int.get("ft_orig")
        lt2 = bm2.faces.layers.int.get("ft_tag")
        sig_after = signatures(bm2, mw, only=lambda f: f[lt2] == 0)
        identical = sig_after == sig_before
        after_counts = (len(bm2.verts), len(bm2.faces))
        orig_of = [f[lo2] for f in bm2.faces]
        tag_of = [f[lt2] for f in bm2.faces]
        bm2.free()
        if had_custom:
            lst = []
            for pi, p in enumerate(me.polygons):
                if tag_of[pi] == 1:
                    lst.extend([chosen_normal[orig_of[pi]]] * p.loop_total)
                else:
                    lst.extend(tuple(x) for x in cn_before[orig_of[pi]])
            me.normals_split_custom_set(lst)
            c2 = np.empty(len(me.loops) * 3)
            me.corner_normals.foreach_get("vector", c2)
            want = np.array(lst)
            got = c2.reshape(-1, 3)
            dev = float(np.degrees(np.arccos(np.clip((want * got).sum(axis=1) / np.maximum(np.linalg.norm(want, axis=1) * np.linalg.norm(got, axis=1), 1e-30), -1, 1))).max())
            custom_report = {"custom_normals": True, "max_deviation_from_intended_deg": round(dev, 4), "subfaces_get_the_parent_normal": True}
        # drop the helper attributes
        for nm in ("ft_orig", "ft_tag"):
            a = me.attributes.get(nm)
            if a is not None:
                me.attributes.remove(a)
    bm.free()
    name = L.param("name", "face_trim")
    outd = L.ARGS.get("out_dir")
    full = None
    if outd:
        os.makedirs(outd, exist_ok=True)
        full = os.path.join(outd, name + ".json")
        with open(full, "w", encoding="utf-8") as fh:
            json.dump({"part": ob.name, "chosen_faces": chosen, "planes": n_planes}, fh)
    L.finish({"part": ob.name, "dry_run": dry, "chosen_faces": len(chosen), "planes_cut": n_planes, "subfaces": len(subs),
              "removed_subfaces": len(removed), "kept_subfaces": len(kept),
              "removed_area_m2": round(rem_area, 6), "kept_area_m2": round(kept_area, 6), "chosen_area_before_m2": round(area_before, 6),
              "area_conserved": abs(rem_area + kept_area - area_before) < 1e-6 * max(1.0, area_before), "kept_examples": kept_examples,
              "uv_area_conserved": uv_ratio, "counts_before": {"vertices": counts_before[0], "faces": counts_before[1]},
              "counts_after": ({"vertices": after_counts[0], "faces": after_counts[1]} if after_counts else None),
              "survivors_identical": identical, "custom_normals": custom_report, "full_list_file": full,
              "notes": ["coverage is point-sampled: 7 samples per triangle", "the cutting planes come from the covering faces' own edges"]},
             save=not dry)


L.run(main)
