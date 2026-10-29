"""face_remove — delete CHOSEN faces of a mesh after PROVING the surviving geometry covers them. Everything that stays keeps its position, material and UV. Saves a checkpoint (not with dry_run).

For redundant faces hidden or doubled by other faces (exact duplicate sheets, a face under its twin): you choose the faces (e.g. `faces_a` / `faces_b` from `coplanar_audit`), the verb tests them and removes them; nothing is guessed, no box or vertex group decides.
params:
  part        the object (required); a mesh shared with another object, with shape keys or with modifiers is refused
  select      `{"faces": [indices]}` or filters ANDed: `components` (piece numbers as `face_orient` numbers them), `box` (WORLD metres, faces whose centre is inside), `plane` ({"point","normal","dist_tol_m" 0.002,"angle_tol_deg" 2,"either_side" true}, WORLD), as in `normals_edit`
  cover       the coverage proof (default on). Each chosen face is sampled (7 points per triangle) and each sample must be matched by a SURVIVING face (not chosen) of this mesh: within `cover_dist_m` (default 0.0005) of the sample along the face normal, normal within `cover_angle_deg` (default 1), and facing `cover_facing` "same" (default: the survivor looks the same way, so what a viewer sees cannot change) or "any" (a back-to-back survivor also counts; the look from the removed face's side CHANGES, use only to drop hidden contact faces)
  require_covered  true (default): refuse to remove anything when a sample is uncovered (the dry run still reports it); false: remove anyway and report
  cover_by    optional list of OTHER object names / globs whose faces (evaluated, world) also count as covering survivors, e.g. a beam covered by the channel that sits on it
  expect      {"faces": n} refuses when the chosen count differs
  dry_run     true: the proof and counts only
  name        file stem of the full list (default face_remove)
Returns: `chosen` (faces, area m2, pieces), `coverage` (samples, covered, covered_share, `uncovered_faces` with examples; per face the worst sample offset), `removed_faces` (first 200; all in out/<name>.json), counts before / after (vertices, faces; vertices left with no face are removed), `survivors_identical` (every surviving face has the same world positions, material index and UV-at-corner pairs, multiset comparison over all UV layers), `materials_unchanged`, `uv_unchanged` (as survivors), `vertex_groups_note`.
Limits: tests this mesh's own survivors plus the objects named in `cover_by` (nothing else covers); coverage is point-sampled (7 per triangle), not an exact area proof: an uncovered sliver smaller than the sample spacing can pass, so look at the dry-run share and examples.
"""
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


def world_area(f, mw):
    """area in WORLD square metres (a bmesh face's own area is in object space and ignores the object's scale)"""
    pts = [mw @ v.co for v in f.verts]
    s = Vector((0.0, 0.0, 0.0))
    for i in range(len(pts)):
        s += pts[i].cross(pts[(i + 1) % len(pts)])
    return s.length / 2.0


def signatures(bm, mw):
    """multiset of per-face signatures: world positions (rounded 1e-6, as a sorted-by-start loop), material, UV pairs"""
    out = {}
    uvl = list(bm.loops.layers.uv.values())
    for f in bm.faces:
        pts = [tuple(round(c, 6) for c in (mw @ lp.vert.co)) for lp in f.loops]
        k = min(range(len(pts)), key=lambda i: pts[i])
        ring = tuple(pts[k:] + pts[:k])
        uvs = tuple(tuple((layer.name, round(lp[layer].uv.x, 6), round(lp[layer].uv.y, 6)) for layer in uvl) for lp in f.loops)
        uvs = tuple(uvs[k:] + uvs[:k])
        key = (ring, f.material_index, uvs, f.smooth)
        out[key] = out.get(key, 0) + 1
    return out


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
        raise RuntimeError(f"{ob.name}: has modifiers; refusing (face numbers would not match the evaluated mesh)")
    had_custom = bool(me.has_custom_normals)
    sel = L.param("select") or {}
    mw = ob.matrix_world.copy()
    M3 = np.array(mw)[:3, :3]
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
            if any(not 0 <= i < ncomp for i in want):
                raise RuntimeError(f"select.components: outside 0..{ncomp - 1}")
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
            fn = np.array([np.linalg.inv(M3).T @ np.array(bm.faces[i].normal) for i in range(nf)])
            fn /= np.maximum(np.linalg.norm(fn, axis=1), 1e-30)[:, None]
            dots = fn @ pn
            okn = (np.abs(dots) >= at) if pl.get("either_side", True) else (dots >= at)
            keep &= (np.abs((cen - pp) @ pn) <= dt) & okn
        chosen = [int(i) for i in np.nonzero(keep)[0]]
    if not chosen:
        raise RuntimeError("nothing chosen")
    exp = L.param("expect")
    if exp and "faces" in exp and exp["faces"] != len(chosen):
        raise RuntimeError(f"expect {exp['faces']} faces but {len(chosen)} chosen: nothing changed")
    cset = set(chosen)
    if len(cset) == nf:
        raise RuntimeError("the selection is the whole mesh; refusing")
    # ---- coverage proof against the survivors (world space)
    dist_tol = float(L.param("cover_dist_m", 0.0005))
    cos_t = math.cos(math.radians(float(L.param("cover_angle_deg", 1.0))))
    facing = L.param("cover_facing", "same")
    if facing not in ("same", "any"):
        raise RuntimeError("cover_facing: same | any")
    do_cover = L.param("cover", True)
    cov = None
    require = bool(L.param("require_covered", True))
    uncovered_faces = []
    if do_cover:
        sv, st, snorm = [], [], []
        idx = {}
        M3it = np.linalg.inv(M3).T
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
        cb = L.param("cover_by") or []
        if isinstance(cb, str):
            cb = [cb]
        import fnmatch
        dg = bpy.context.evaluated_depsgraph_get()
        others = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name != ob.name and any(fnmatch.fnmatchcase(o.name, g) for g in cb)]
        for o in others:
            ev = o.evaluated_get(dg)
            m2 = ev.to_mesh()
            try:
                w2 = ev.matrix_world
                A3 = np.array(w2)[:3, :3]
                A3it = np.linalg.inv(A3).T
                base = len(sv)
                sv.extend(w2 @ v.co for v in m2.vertices)
                m2.calc_loop_triangles()
                for t in m2.loop_triangles:
                    st.append((base + t.vertices[0], base + t.vertices[1], base + t.vertices[2]))
                    snorm.append(Vector(A3it @ np.array(t.normal)).normalized())
            finally:
                ev.to_mesh_clear()
        bvh = BVHTree.FromPolygons(sv, st, all_triangles=True, epsilon=0.0) if st else None
        samples = covered = 0
        worst = {}
        bw = [(1 / 3, 1 / 3, 1 / 3), (0.8, 0.1, 0.1), (0.1, 0.8, 0.1), (0.1, 0.1, 0.8), (0.45, 0.45, 0.1), (0.1, 0.45, 0.45), (0.45, 0.1, 0.45)]
        for fi in chosen:
            f = bm.faces[fi]
            n = (Vector((M3 @ np.array(f.normal))) if True else None)
            n = Vector(np.linalg.inv(M3).T @ np.array(f.normal)).normalized()
            vs = [mw @ v.co for v in f.verts]
            worst_f = 0.0
            ok_all = True
            for k in range(1, len(vs) - 1):
                tri = (vs[0], vs[k], vs[k + 1])
                for a, b, c in bw:
                    p = tri[0] * a + tri[1] * b + tri[2] * c
                    samples += 1
                    hit_ok = False
                    best = None
                    if bvh is not None:
                        for sgn in (1.0, -1.0):
                            o = p + n * (sgn * dist_tol * 2.0)
                            loc, hn, hi_, dd = bvh.ray_cast(o, -n * sgn, dist_tol * 4.0)
                            if loc is None:
                                continue
                            sfn = snorm[hi_]
                            dot = sfn.dot(n)
                            off = abs((loc - p).dot(n))
                            if abs(dot) >= cos_t and off <= dist_tol and (dot > 0 or facing == "any"):
                                hit_ok = True
                                best = off if best is None else min(best, off)
                    if hit_ok:
                        covered += 1
                        worst_f = max(worst_f, best or 0.0)
                    else:
                        ok_all = False
            worst[fi] = worst_f
            if not ok_all:
                uncovered_faces.append(fi)
        cov = {"samples": samples, "covered": covered, "covered_share": round(covered / max(1, samples), 6),
               "uncovered_faces": uncovered_faces[:100], "uncovered_face_count": len(uncovered_faces),
               "worst_offset_m": round(max(worst.values()) if worst else 0.0, 6), "cover_dist_m": dist_tol, "cover_angle_deg": float(L.param("cover_angle_deg", 1.0)), "cover_facing": facing}
        if uncovered_faces and require and not L.param("dry_run", False):
            raise RuntimeError(f"{len(uncovered_faces)} of {len(chosen)} chosen faces are not covered by surviving faces (first: {uncovered_faces[:8]}): nothing removed; dry_run shows the proof")
    area = sum(world_area(bm.faces[i], mw) for i in chosen)
    comp_of, ncomp = pieces(bm)
    touched = sorted({comp_of[bm.faces[i].verts[0].index] for i in chosen})
    before_counts = (len(bm.verts), len(bm.faces))
    sig_before = signatures(bm, mw)
    cn_before = None
    if had_custom:
        cn = np.empty(len(me.loops) * 3)
        me.corner_normals.foreach_get("vector", cn)
        cn = cn.reshape(-1, 3)
        cn_before = {p.index: cn[p.loop_start:p.loop_start + p.loop_total].copy() for p in me.polygons}
    for i in chosen:
        k = None
    dry = bool(L.param("dry_run", False))
    identical = None
    after_counts = None
    custom_report = None
    if not dry:
        # the survivors' signatures before = signatures after, once the chosen faces' own signatures are taken out
        for i in chosen:
            f = bm.faces[i]
        sig_chosen = {}
        tmp_sig = signatures(bm, mw)
        # signature of chosen faces
        uvl = list(bm.loops.layers.uv.values())
        for i in chosen:
            f = bm.faces[i]
            pts = [tuple(round(c, 6) for c in (mw @ lp.vert.co)) for lp in f.loops]
            k = min(range(len(pts)), key=lambda q: pts[q])
            ring = tuple(pts[k:] + pts[:k])
            uvs = tuple(tuple((layer.name, round(lp[layer].uv.x, 6), round(lp[layer].uv.y, 6)) for layer in uvl) for lp in f.loops)
            uvs = tuple(uvs[k:] + uvs[:k])
            key = (ring, f.material_index, uvs, f.smooth)
            sig_chosen[key] = sig_chosen.get(key, 0) + 1
        expect_sig = dict(sig_before)
        for k_, c_ in sig_chosen.items():
            expect_sig[k_] -= c_
            if expect_sig[k_] == 0:
                del expect_sig[k_]
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in chosen], context="FACES")
        bm.to_mesh(me)
        me.update()
        custom_report = None
        if had_custom:
            keep_order = [i for i in range(nf) if i not in cset]
            want = np.vstack([cn_before[i] for i in keep_order])

            def now():
                c2 = np.empty(len(me.loops) * 3)
                me.corner_normals.foreach_get("vector", c2)
                return c2.reshape(-1, 3)
            got = now()
            dev = float(np.degrees(np.arccos(np.clip((want * got).sum(axis=1) / np.maximum(np.linalg.norm(want, axis=1) * np.linalg.norm(got, axis=1), 1e-30), -1, 1))).max()) if len(want) == len(got) else None
            restored = False
            if dev is None or dev > 0.01 or not me.has_custom_normals:
                me.normals_split_custom_set([tuple(x) for x in want])
                restored = True
                got = now()
                dev = float(np.degrees(np.arccos(np.clip((want * got).sum(axis=1) / np.maximum(np.linalg.norm(want, axis=1) * np.linalg.norm(got, axis=1), 1e-30), -1, 1))).max()) if len(want) == len(got) else None
            custom_report = {"custom_normals": True, "survivor_corner_normals_max_deviation_deg": None if dev is None else round(dev, 4), "restored_with_normals_split_custom_set": restored, "survivors_corners": int(len(want))}
        bm2 = bmesh.new()
        bm2.from_mesh(me)
        sig_after = signatures(bm2, mw)
        identical = sig_after == expect_sig
        after_counts = (len(bm2.verts), len(bm2.faces))
        bm2.free()
    bm.free()
    name = L.param("name", "face_remove")
    outd = L.ARGS.get("out_dir")
    full = None
    if outd:
        os.makedirs(outd, exist_ok=True)
        full = os.path.join(outd, name + ".json")
        with open(full, "w", encoding="utf-8") as fh:
            json.dump({"part": ob.name, "removed_faces": chosen, "uncovered_faces": uncovered_faces}, fh)
    L.finish({"part": ob.name, "dry_run": dry, "chosen": {"faces": len(chosen), "area_m2": round(area, 6), "pieces_touched": touched},
              "coverage": cov, "removed_faces": chosen[:200], "removed_listed": min(200, len(chosen)), "full_list_file": full,
              "counts_before": {"vertices": before_counts[0], "faces": before_counts[1]},
              "counts_after": ({"vertices": after_counts[0], "faces": after_counts[1]} if after_counts else None),
              "survivors_identical": identical, "custom_normals": custom_report if had_custom else {"custom_normals": False},
              "vertex_groups_note": "vertices still used by a surviving face keep their groups; vertices left with no face are removed",
              "notes": ["coverage is point-sampled: 7 samples per triangle"]},
             save=not dry)


L.run(main)
