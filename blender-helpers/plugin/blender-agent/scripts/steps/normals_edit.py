"""normals_edit — turn the winding of CHOSEN faces over and/or set their shading, nothing else: vertex positions, materials, UV-at-corner pairs, vertex groups, face order and counts stay as they are. Saves a checkpoint (not with dry_run).

You choose the faces; nothing is inferred (no outside / inside guess, least of all on open sheets).
params:
  part        the object (required); a mesh shared with another object, or with shape keys, is refused
  select      the faces (give `faces` OR any of the filters, which are ANDed):
                faces        [face indices]                      explicit (face numbers as `scene_ray` / `face_orient` examples report them)
                components   [piece numbers]                     pieces as `face_orient` numbers them (faces joined through shared vertices)
                box          [[xmin,ymin,zmin],[xmax,ymax,zmax]] WORLD metres: faces whose centre is inside
                plane        {"point": [x,y,z], "normal": [nx,ny,nz], "dist_tol_m": 0.002, "angle_tol_deg": 2, "either_side": true}  WORLD: faces whose centre lies within dist_tol of the plane and whose normal is within angle_tol of the plane normal (either_side: of its opposite too). A planar patch on an open sheet that holds both outer and inner surfaces.
  flip        true: reverse the winding of every chosen face (the corner data, UVs included, goes with its vertex)
  shading     "keep" (default) | "smooth" | "flat" | "angle": for the chosen faces smooth / flat; "angle" = smooth faces and mark an edge SHARP when its two faces meet at more than `angle_deg` (default 30) or when one of them is not chosen
  custom_normals  "reverse" (default) | "keep" | "align": on a mesh with custom split normals, whether `flip` also REVERSES the chosen corners' normals (the normals follow the winding) or KEEPS them exactly as they are (use when they already point the way you want, e.g. opposite the old winding); every unchosen corner is kept either way
  (custom_normals "align": the chosen faces' corner normals are SET to their face's visible normal (object-space normal of the face as it is after any `flip`), with or without `flip`; winding is not touched unless `flip` is also given; every other corner normal is kept; for flat faces. The report gives `corners_aligned` and the largest angle the old normals made with the face)
  clear_custom_normals  true: drop custom split normals first (a mesh WITH custom split normals is handled: with `flip` the chosen faces' corner normals are REVERSED with them and every other corner normal is kept; shading changes are refused on such a mesh unless you clear them)
  dry_run     true: report only
Returns: `chosen` (faces, pieces touched), `changed_faces` (indices; all of them in out/<name>.json, `name` default normals_edit; the report lists the first 200), `flipped`, `shading_changed`, `sharp_edges_marked`, `winding_inconsistent_edges` before / after (a patch of turned faces next to unturned ones leaves such edges on its border: expected, and listed), `positions_unchanged`, `materials_unchanged`, `uv_corner_pairs_unchanged` (per chosen face the set of (vertex, UV) pairs, over every UV layer, before = after), `unchosen_faces_untouched`, `counts_unchanged`. Selecting nothing refuses. `expect` {"faces": n} refuses when the count differs.
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
import _lib as L  # noqa: E402


def h(a):
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()[:16]


def corner_pairs(bm, fi):
    f = bm.faces[fi]
    out = set()
    for layer in bm.loops.layers.uv.values():
        for lp in f.loops:
            out.add((layer.name, lp.vert.index, round(lp[layer].uv.x, 6), round(lp[layer].uv.y, 6)))
    return out


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


def inconsistent(bm):
    return sum(1 for e in bm.edges if len(e.link_faces) == 2 and not e.is_contiguous)


def main():
    ob = bpy.data.objects.get(L.param("part", ""))
    if ob is None or ob.type != "MESH":
        raise RuntimeError(f"part: no mesh object named {L.param('part')!r}")
    me = ob.data
    if me.users > 1:
        raise RuntimeError(f"{ob.name}: the mesh is shared by {me.users} users; refusing")
    if me.shape_keys is not None:
        raise RuntimeError(f"{ob.name}: has shape keys; refusing")
    flip = bool(L.param("flip", False))
    cn_mode = L.param("custom_normals", "reverse")
    if cn_mode not in ("reverse", "keep", "align"):
        raise RuntimeError("custom_normals: reverse | keep | align")
    shading = L.param("shading", "keep")
    if shading not in ("keep", "smooth", "flat", "angle"):
        raise RuntimeError("shading: keep | smooth | flat | angle")
    if not flip and shading == "keep" and cn_mode != "align":
        raise RuntimeError("nothing to do: give flip, shading and/or custom_normals: align")
    keep_custom = bool(me.has_custom_normals) and not L.param("clear_custom_normals", False)
    if keep_custom and shading != "keep":
        raise RuntimeError(f"{ob.name}: has custom split normals; shading changes would not show (give clear_custom_normals:true to drop them, or flip only)")
    sel = L.param("select") or {}
    mw = ob.matrix_world
    M3 = np.array(mw)[:3, :3]
    mt = np.array(mw)[:3, 3]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
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
        if "components" in sel:
            comp_of, ncomp = pieces(bm)
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
    comp_of, ncomp = pieces(bm)
    touched = sorted({comp_of[bm.faces[i].verts[0].index] for i in chosen})
    # fingerprints before
    pos_before = np.array([v.co[:] for v in bm.verts])
    mat_before = np.array([f.material_index for f in bm.faces], dtype=np.int32)
    pairs_before = {i: corner_pairs(bm, i) for i in chosen}
    others_before = {i: (tuple(v.index for v in bm.faces[i].verts), frozenset(corner_pairs(bm, i)), bm.faces[i].smooth) for i in range(nf) if i not in cset}
    incons_before = inconsistent(bm)
    counts_before = (len(bm.verts), len(bm.edges), len(bm.faces))
    dry = bool(L.param("dry_run", False))
    sharp_marked = 0
    smooth_changed = 0
    custom_report = {"custom_normals": False}
    if not dry:
        if me.has_custom_normals and not keep_custom:
            bpy.context.view_layer.objects.active = ob
            bm.free()
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.verts.ensure_lookup_table()
            bm.faces.ensure_lookup_table()
            bm.edges.ensure_lookup_table()
        fs = [bm.faces[i] for i in chosen]
        if flip:
            bmesh.ops.reverse_faces(bm, faces=fs)
        if shading != "keep":
            want_smooth = shading in ("smooth", "angle")
            for f in fs:
                if f.smooth != want_smooth:
                    smooth_changed += 1
                f.smooth = want_smooth
            if shading == "angle":
                lim = math.radians(float(L.param("angle_deg", 30)))
                es = {e for f in fs for e in f.edges}
                for e in es:
                    lf = e.link_faces
                    sharp = len(lf) != 2 or any(x.index not in cset for x in lf) or e.calc_face_angle(0.0) > lim
                    if sharp and e.smooth:
                        e.smooth = False
                        sharp_marked += 1
                    elif not sharp and not e.smooth:
                        e.smooth = True
        cust_old = None
        if keep_custom:
            cn = np.empty(len(me.loops) * 3)
            me.corner_normals.foreach_get("vector", cn)
            cn = cn.reshape(-1, 3)
            cust_old = {}
            for p_ in me.polygons:
                for li in range(p_.loop_start, p_.loop_start + p_.loop_total):
                    cust_old[(p_.index, me.loops[li].vertex_index)] = cn[li].copy()
        bm.to_mesh(me)
        me.update()
        if keep_custom:
            lst = []
            nflip = 0
            naligned = 0
            ang_before = 0.0
            for p_ in me.polygons:
                for li in range(p_.loop_start, p_.loop_start + p_.loop_total):
                    vec = cust_old[(p_.index, me.loops[li].vertex_index)]
                    if p_.index in cset and cn_mode == "align":
                        a_ = np.array(vec)
                        b_ = np.array(p_.normal)
                        ang_before = max(ang_before, float(np.degrees(np.arccos(np.clip(a_ @ b_ / max(np.linalg.norm(a_) * np.linalg.norm(b_), 1e-30), -1, 1)))))
                        vec = b_
                        naligned += 1
                    elif flip and p_.index in cset and cn_mode == "reverse":
                        vec = -vec
                        nflip += 1
                    lst.append(tuple(vec))
            me.normals_split_custom_set(lst)
            cn2 = np.empty(len(me.loops) * 3)
            me.corner_normals.foreach_get("vector", cn2)
            want = np.array(lst)
            got = cn2.reshape(-1, 3)
            dev = float(np.degrees(np.arccos(np.clip((want * got).sum(axis=1) / np.maximum(np.linalg.norm(want, axis=1) * np.linalg.norm(got, axis=1), 1e-30), -1, 1))).max())
            custom_report = {"custom_normals": True, "corners_reversed": nflip, "corners_aligned": naligned, "aligned_corner_max_angle_to_face_before_deg": round(ang_before, 3), "mode": cn_mode, "unchosen_corner_normals_kept": True, "max_deviation_from_intended_deg": round(dev, 4)}
    # fingerprints after (read the mesh back)
    bm2 = bmesh.new()
    bm2.from_mesh(me)
    bm2.verts.ensure_lookup_table()
    bm2.faces.ensure_lookup_table()
    pos_same = bool(np.array_equal(pos_before, np.array([v.co[:] for v in bm2.verts])))
    mat_same = bool(np.array_equal(mat_before, np.array([f.material_index for f in bm2.faces], dtype=np.int32)))
    pairs_same = all(corner_pairs(bm2, i) == pairs_before[i] for i in chosen)
    untouched = all((tuple(v.index for v in bm2.faces[i].verts), frozenset(corner_pairs(bm2, i)), bm2.faces[i].smooth) == others_before[i] for i in others_before)
    incons_after = inconsistent(bm2)
    counts_after = (len(bm2.verts), len(bm2.edges), len(bm2.faces))
    bm2.free()
    bm.free()
    name = L.param("name", "normals_edit")
    outd = os.path.join(L.ARGS["out_dir"]) if "out_dir" in L.ARGS else None
    full = None
    if outd:
        os.makedirs(outd, exist_ok=True)
        full = os.path.join(outd, name + ".json")
        with open(full, "w", encoding="utf-8") as fh:
            json.dump({"part": ob.name, "changed_faces": chosen}, fh)
    L.finish({"part": ob.name, "dry_run": dry, "chosen": {"faces": len(chosen), "pieces_touched": touched, "pieces_in_mesh": ncomp},
              "changed_faces": chosen[:200], "changed_faces_listed": min(200, len(chosen)), "full_list_file": full,
              "flipped": len(chosen) if (flip and not dry) else 0, "shading_changed": smooth_changed, "sharp_edges_marked": sharp_marked,
              "winding_inconsistent_edges": {"before": incons_before, "after": incons_after,
                                             "note": "a turned patch next to unturned faces leaves such edges on its border; 0 after means the piece is consistent"},
              "positions_unchanged": pos_same, "materials_unchanged": mat_same, "uv_corner_pairs_unchanged": pairs_same,
              "unchosen_faces_untouched": untouched, "counts_unchanged": counts_before == counts_after, "custom_normals": custom_report},
             save=not dry)


L.run(main)
