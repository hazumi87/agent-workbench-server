"""face_orient — READ-ONLY orientation audit of mesh surfaces: which faces look OUT of their piece, which look in, and what the shading normals and materials do about it. Nothing is changed or saved.

params:
  objects       names or globs (required); every mesh among them, evaluated (modifiers applied, as exported)
  max_ray_faces per component, how many faces get the ray test (default 4000; an even stride picks them, the signed volume and the winding check always use ALL faces)
  examples      how many example faces to list per verdict (default 6)
  side_max_m    open pieces: how far the front/back probe rays look (default 5 m)
Per object: `world_det_sign` (-1 = mirrored transform: the visible side of a face is then the opposite of the stored winding order; this audit already accounts for it), and per connected component (pieces joined by shared vertices):
  faces, bounds_m, `closed` (no boundary edge, no edge with 3+ faces), `winding_inconsistent_edges` (two faces share an edge but run the same way round: a flipped patch inside the piece),
  `signed_volume_m3` (visible sides, world: > 0 the visible sides look out, < 0 in) and `volume_basis`,
  `ray_test` (closed pieces only): faces tested, `outward`, `inward`, `split` (fewer than 80% of the rays agree: 5 are cast, 7 more when they are undecided), shares, examples (face index, centre, visible normal),
  `shading` : custom normals present, share of smooth faces, angle between each corner's shading normal and its face's visible normal (mean, p95, max) the count of corners over 90 degrees (a shading normal on the opposite side of the face = a dark or inverted look), and the same by face AREA (`area_share_with_a_corner_over_90deg` / `_60deg`, faces and total m2): read the area share before calling a corner count a cause,
  `materials`: per material used: faces, `backface_culling`, `gltf_double_sided` (= not culling), base colour,
  `open_sheet_probe` (pieces that are not closed): for up to 150 faces, a ray along the visible normal (front) and against it (back) into the whole scene: share that sees nothing within side_max_m, median hit distance, share that hits within 10 mm. A sheet whose FRONT is blocked at a few mm and whose BACK is open is facing into a wall or a body: turned the wrong way for its job,
  `verdict`: "outward" | "inward" | "mixed" | "open_indeterminate" | "degenerate", and `why` in words.
Honest limits: a piece that is not closed (a plane, a lid, a leaf card, a shell with a hole) has no inside, so its faces cannot be called out or in; it gets `open_indeterminate` plus the winding check and the shading numbers, and whether it is one-sided is read from the material. A closed piece with nested shells in ONE component, or touching/overlapping neighbours, can fool the ray count (the rays only meet the piece's own faces; other objects are ignored). Degenerate (zero-area) faces are skipped and counted. Components of different objects that overlap are not compared with each other.
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
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402


def base_colour(mat):
    if mat is None:
        return None
    if mat.use_nodes:
        for n in mat.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                c = n.inputs["Base Color"].default_value
                return {"rgba_linear": [round(c[i], 3) for i in range(4)], "texture_linked": bool(n.inputs["Base Color"].is_linked)}
    return {"viewport_rgba": [round(mat.diffuse_color[i], 3) for i in range(4)]}


def crossings(bvh, org, d, cap=64):
    n = 0
    o = Vector(org)
    for _ in range(cap):
        loc, nrm, idx, dist = bvh.ray_cast(o, d)
        if loc is None:
            return n
        n += 1
        o = loc + d * 1e-6
    return n


def perp(n):
    a = Vector((1, 0, 0)) if abs(n.x) < 0.8 else Vector((0, 1, 0))
    u = n.cross(a).normalized()
    return u, n.cross(u).normalized()


def audit_object(ob, dg, max_ray, nex, side_max_m=5.0, weld_m=0.0):
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        mw = ev.matrix_world
        det = mw.determinant()
        sgn = -1.0 if det < 0 else 1.0
        me.calc_loop_triangles()
        nv = len(me.vertices)
        co = np.empty(nv * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co)
        co = co.reshape(nv, 3)
        m = np.array(mw)[:3, :3]
        t = np.array(mw)[:3, 3]
        minv = np.linalg.inv(m)
        wco = co @ m.T + t
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        # components by shared vertices
        comp_of = [-1] * len(bm.verts)
        comps = []
        for v in bm.verts:
            if comp_of[v.index] != -1 or not v.link_faces:
                continue
            ci = len(comps)
            stack = [v]
            comp_of[v.index] = ci
            vs = []
            while stack:
                a = stack.pop()
                vs.append(a.index)
                for e in a.link_edges:
                    b = e.other_vert(a)
                    if comp_of[b.index] == -1:
                        comp_of[b.index] = ci
                        stack.append(b)
            comps.append(vs)
        faces_by_comp = [[] for _ in comps]
        for f in bm.faces:
            faces_by_comp[comp_of[f.verts[0].index]].append(f.index)
        wid = None
        if weld_m > 0:
            # positional weld ANALYSIS only: vertices within weld_m of each other count as one for connectivity and edge sharing; the model is not changed and face numbers stay the mesh's own
            from mathutils.kdtree import KDTree
            kd = KDTree(nv)
            for i_ in range(nv):
                kd.insert(Vector(wco[i_]), i_)
            kd.balance()
            parent = list(range(nv))

            def find(a):
                while parent[a] != a:
                    parent[a] = parent[parent[a]]
                    a = parent[a]
                return a
            for i_ in range(nv):
                for _, j_, _d in kd.find_range(Vector(wco[i_]), weld_m):
                    ra, rb = find(i_), find(j_)
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
            wid = [find(i_) for i_ in range(nv)]
            fparent = {}

            def ffind(a):
                while fparent.setdefault(a, a) != a:
                    fparent[a] = fparent[fparent[a]]
                    a = fparent[a]
                return a
            for f in bm.faces:
                r0 = ffind(wid[f.verts[0].index])
                for v in f.verts[1:]:
                    r1 = ffind(wid[v.index])
                    if r0 != r1:
                        fparent[max(r0, r1)] = min(r0, r1)
                        r0 = min(r0, r1)
            order = {}
            faces_by_comp = []
            for f in bm.faces:
                r = ffind(wid[f.verts[0].index])
                if r not in order:
                    order[r] = len(faces_by_comp)
                    faces_by_comp.append([])
                faces_by_comp[order[r]].append(f.index)
        corner_n = None
        try:
            corner_n = np.empty(len(me.loops) * 3, dtype=np.float64)
            me.corner_normals.foreach_get("vector", corner_n)
            corner_n = corner_n.reshape(-1, 3)
        except Exception:  # noqa: BLE001
            corner_n = None
        out_comps = []
        for ci, fids in enumerate(faces_by_comp):
            if not fids:
                continue
            nrm = np.zeros((len(fids), 3))
            cen = np.zeros((len(fids), 3))
            area = np.zeros(len(fids))
            tris = []
            for k, fi in enumerate(fids):
                f = bm.faces[fi]
                pts = wco[[v.index for v in f.verts]]
                # Newell normal (stored winding, world) times the sign of the transform = the VISIBLE side
                nn = np.zeros(3)
                for i in range(len(pts)):
                    p, q = pts[i], pts[(i + 1) % len(pts)]
                    nn += np.cross(p, q)
                a2 = np.linalg.norm(nn)
                area[k] = 0.5 * a2
                nrm[k] = (nn / a2 * sgn) if a2 > 1e-18 else 0.0
                cen[k] = pts.mean(axis=0)
                for i in range(1, len(pts) - 1):
                    tris.append((f.verts[0].index, f.verts[i].index, f.verts[i + 1].index))
            ok = area > 1e-12
            volume = float(np.sum(area[ok] * np.einsum("ij,ij->i", cen[ok], nrm[ok])) / 3.0)
            vids = sorted({v.index for fi in fids for v in bm.faces[fi].verts})
            allpts = wco[vids]
            lo, hi = allpts.min(axis=0), allpts.max(axis=0)
            diag = float(np.linalg.norm(hi - lo))
            if wid is None:
                es = {e.index for fi in fids for e in bm.faces[fi].edges}
                boundary = sum(1 for ei in es if len(bm.edges[ei].link_faces) == 1)
                nonman = sum(1 for ei in es if len(bm.edges[ei].link_faces) > 2)
                wrong = sum(1 for ei in es if len(bm.edges[ei].link_faces) == 2 and not bm.edges[ei].is_contiguous)
            else:
                ed = {}
                for fi in fids:
                    vv = [wid[v.index] for v in bm.faces[fi].verts]
                    for q in range(len(vv)):
                        a_, b_ = vv[q], vv[(q + 1) % len(vv)]
                        if a_ == b_:
                            continue
                        ed.setdefault((min(a_, b_), max(a_, b_)), []).append(1 if a_ < b_ else -1)
                boundary = sum(1 for d_ in ed.values() if len(d_) == 1)
                nonman = sum(1 for d_ in ed.values() if len(d_) > 2)
                wrong = sum(1 for d_ in ed.values() if len(d_) == 2 and d_[0] == d_[1])
            closed = boundary == 0 and nonman == 0
            comp = {"component": ci, "faces": len(fids), "degenerate_faces_skipped": int((~ok).sum()),
                    "bounds_m": [[round(float(x), 4) for x in lo], [round(float(x), 4) for x in hi]], "size_m": round(diag, 4),
                    "boundary_edges": boundary, "non_manifold_edges": nonman, "closed": closed,
                    "winding_inconsistent_edges": wrong, "signed_volume_m3": round(volume, 6),
                    **({"welded_pieces_by_position_m": weld_m, "face_ids": fids[:2000], "face_ids_truncated": len(fids) > 2000} if wid is not None else {}),
                    "volume_basis": "sum over all faces of (centre . visible normal) x area / 3; only meaningful when closed"}
            # ray test (closed only)
            rt = None
            n_out = n_in = n_split = 0
            ex = {"outward": [], "inward": [], "split": []}
            if closed and ok.any():
                remap = {v: i for i, v in enumerate(vids)}
                bvh = BVHTree.FromPolygons([Vector(p) for p in wco[vids]], [(remap[a], remap[b], remap[c]) for a, b, c in tris], all_triangles=True)
                idxs = np.nonzero(ok)[0]
                step = max(1, int(math.ceil(len(idxs) / max(1, max_ray))))
                sample = idxs[::step]
                eps = max(1e-5, 1e-4 * diag)
                for k in sample:
                    n = Vector(nrm[k])
                    u, v = perp(n)
                    # start off the face centre and off its diagonals (a ray through a quad's centre runs along its triangulation diagonal on the far side) and never along the normal itself
                    f0 = bm.faces[fids[k]]
                    org = Vector(cen[k]) * 0.55 + (Vector(wco[f0.verts[0].index]) * 0.69 + Vector(wco[f0.verts[1].index]) * 0.31) * 0.45 + n * eps
                    votes = []
                    for j, tilt in enumerate((0.23, 0.41, 0.57, 0.31, 0.47)):
                        a = 2.399963 * (j + 1) + 0.7
                        votes.append(crossings(bvh, org, (n + (u * math.cos(a) + v * math.sin(a)) * tilt).normalized()) % 2 == 0)
                    if 2 <= sum(votes) <= 3:  # undecided: seven more rays at other angles, decide on the 12 (a ray that meets an edge exactly can miss)
                        for j, tilt in enumerate((0.15, 0.27, 0.36, 0.52, 0.62, 0.34, 0.44)):
                            a = 2.399963 * (j + 9) + 2.1
                            votes.append(crossings(bvh, org, (n + (u * math.cos(a) + v * math.sin(a)) * tilt).normalized()) % 2 == 0)
                    fr = sum(votes) / len(votes)
                    if fr >= 0.75:
                        n_out += 1
                        key = "outward"
                    elif fr <= 0.25:
                        n_in += 1
                        key = "inward"
                    else:
                        n_split += 1
                        key = "split"
                    if len(ex[key]) < nex and key != "outward":
                        ex[key].append({"face": fids[k], "centre_m": [round(float(x), 4) for x in cen[k]], "visible_normal": [round(float(x), 3) for x in nrm[k]]})
                tot = max(1, n_out + n_in + n_split)
                rt = {"faces_tested": int(len(sample)), "stride": step, "outward": n_out, "inward": n_in, "split": n_split,
                      "outward_share": round(n_out / tot, 4), "inward_share": round(n_in / tot, 4), "split_share": round(n_split / tot, 4),
                      "examples_inward": ex["inward"], "examples_split": ex["split"]}
            comp["ray_test"] = rt
            # shading
            sh = {"custom_normals": bool(me.has_custom_normals)}
            smooth = sum(1 for fi in fids if bm.faces[fi].smooth)
            sh["smooth_face_share"] = round(smooth / len(fids), 4)
            if corner_n is not None and len(me.loops):
                angs = []
                fmax = []  # per face: area and its largest corner angle
                for k, fi in enumerate(fids):
                    if not ok[k]:
                        continue
                    f = bm.faces[fi]
                    pl = me.polygons[fi]
                    li = range(pl.loop_start, pl.loop_start + pl.loop_total)
                    cn = corner_n[list(li)] @ minv  # normals move with the inverse transpose
                    ln = np.linalg.norm(cn, axis=1)
                    ln[ln == 0] = 1
                    cn = cn / ln[:, None]
                    c = np.clip(cn @ nrm[k], -1, 1)
                    dd = np.degrees(np.arccos(c))
                    angs.extend(dd.tolist())
                    fmax.append((float(area[k]), float(dd.max())))
                if angs:
                    a = np.array(angs)
                    sh.update({"corner_vs_face_deg": {"mean": round(float(a.mean()), 2), "p95": round(float(np.percentile(a, 95)), 2), "max": round(float(a.max()), 2)},
                               "corners_over_90deg": int((a > 90).sum()), "corners_over_60deg": int((a > 60).sum()), "corners": int(len(a))})
                    ta = sum(x for x, _ in fmax) or 1.0
                    sh["faces_with_a_corner_over_90deg"] = sum(1 for _, y in fmax if y > 90)
                    sh["area_share_with_a_corner_over_90deg"] = round(sum(x for x, y in fmax if y > 90) / ta, 5)
                    sh["area_share_with_a_corner_over_60deg"] = round(sum(x for x, y in fmax if y > 60) / ta, 5)
                    sh["area_m2_total"] = round(ta, 5)
            else:
                sh["note"] = "corner normals unavailable"
            comp["shading"] = sh
            # materials
            mats = {}
            for fi in fids:
                mi = me.polygons[fi].material_index
                mat = me.materials[mi] if mi < len(me.materials) else None
                nm = mat.name if mat else None
                mats[nm] = mats.get(nm, 0) + 1
            mrep = []
            for nm, cnt in sorted(mats.items(), key=lambda kv: -kv[1]):
                mat = bpy.data.materials.get(nm) if nm else None
                mrep.append({"material": nm, "faces": cnt,
                             "backface_culling": bool(getattr(mat, "use_backface_culling", False)) if mat else None,
                             "gltf_double_sided": (not bool(getattr(mat, "use_backface_culling", False))) if mat else None,
                             "base_colour": base_colour(mat)})
            comp["materials"] = mrep
            # open pieces: what does each side of the sheet look at in the whole scene?
            if not closed and ok.any():
                scn = bpy.context.scene
                idxs = np.nonzero(ok)[0]
                step = max(1, int(math.ceil(len(idxs) / 150)))
                fr, bk = [], []
                for k in idxs[::step]:
                    n = Vector(nrm[k])
                    c0 = Vector(cen[k])
                    for sign_, acc in ((1.0, fr), (-1.0, bk)):
                        d = n * sign_
                        hit, loc, hn, hi, hob, hm = scn.ray_cast(dg, c0 + d * 5e-4, d, distance=side_max_m)
                        acc.append((loc - c0).length if hit else None)

                def stats(a):
                    got = sorted(x for x in a if x is not None)
                    return {"open_share": round(1 - len(got) / max(1, len(a)), 4), "median_hit_m": round(got[len(got) // 2], 4) if got else None,
                            "hit_within_10mm_share": round(sum(1 for x in got if x < 0.01) / max(1, len(a)), 4)}
                comp["open_sheet_probe"] = {"faces_probed": len(fr), "max_m": side_max_m, "front": stats(fr), "back": stats(bk),
                                            "note": "front = the side a viewer sees; hits are against the whole scene (every other piece, this object included), geometry only"}
            # verdict
            if not ok.any():
                comp["verdict"], comp["why"] = "degenerate", "no face has area"
            elif not closed:
                comp["verdict"] = "open_indeterminate"
                comp["why"] = f"not closed ({boundary} boundary edges, {nonman} non-manifold): it has no inside, so out/in cannot be decided from the piece alone; winding inconsistent edges {wrong}"
            else:
                sh_out = rt["outward_share"] if rt else 0
                sh_in = rt["inward_share"] if rt else 0
                if wrong == 0 and volume != 0:
                    # a closed piece whose faces all run the same way round is turned as a whole: the sign of the volume says which way, the rays check it
                    agree = sh_out if volume > 0 else sh_in
                    side = "outward" if volume > 0 else "inward"
                    if agree >= 0.5:
                        comp["verdict"] = side
                        comp["why"] = (f"closed, one winding throughout, volume {volume:.5f} m3 {'>' if volume > 0 else '<'} 0; rays agree on {agree:.1%} of tested faces"
                                       + ("" if rt["split_share"] < 0.05 else f" ({rt['split_share']:.1%} undecided by the rays)")
                                       + (": the whole shell is turned inside out" if side == "inward" else ""))
                    else:
                        comp["verdict"] = "mixed"
                        comp["why"] = f"closed, one winding, volume says {side} but the rays agree on only {agree:.1%}: nested or self-touching shells, read the examples"
                else:
                    comp["verdict"] = "mixed"
                    comp["why"] = f"closed, volume {volume:.5f} m3, outward {sh_out:.1%} / inward {sh_in:.1%} / undecided {rt['split_share']:.1%}, winding inconsistent edges {wrong}: some faces are turned (the per-face rays say which, see examples)"
            out_comps.append(comp)
        bm.free()
        return {"object": ob.name, "parent": ob.parent.name if ob.parent else None, "world_det": round(det, 6), "world_det_sign": int(sgn),
                "negative_transform": det < 0, "world_scale": [round(x, 4) for x in mw.to_scale()], "faces": len(me.polygons),
                "components": out_comps}
    finally:
        ev.to_mesh_clear()


def main():
    pats = L.param("objects") or []
    if isinstance(pats, str):
        pats = [pats]
    if not pats:
        raise RuntimeError("give `objects` (names or globs)")
    max_ray = int(L.param("max_ray_faces", 4000))
    nex = int(L.param("examples", 6))
    side_max = float(L.param("side_max_m", 5.0))
    weld_m = float(L.param("weld_m", 0.0))
    dg = bpy.context.evaluated_depsgraph_get()
    sel = [o for o in bpy.context.scene.objects if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, p) for p in pats)]
    if not sel:
        raise RuntimeError(f"no mesh matches {pats}")
    rep = [audit_object(o, dg, max_ray, nex, side_max, weld_m) for o in sel]
    tally = {}
    for r in rep:
        for c in r["components"]:
            tally[c["verdict"]] = tally.get(c["verdict"], 0) + 1
    findings = []
    for r in rep:
        if r["negative_transform"]:
            findings.append(f"{r['object']}: mirrored transform (det {r['world_det']}); verdicts below already use the visible side")
        for c in r["components"]:
            if c["verdict"] in ("inward", "mixed"):
                findings.append(f"{r['object']} component {c['component']}: {c['verdict']} - {c['why']}")
            if c["shading"].get("corners_over_90deg"):
                findings.append(f"{r['object']} component {c['component']}: {c['shading']['corners_over_90deg']} corners have a shading normal over 90 degrees from the face")
    L.finish({"objects": len(rep), "components_by_verdict": tally, "findings": findings,
              "notes": ["read-only; open pieces are reported as open_indeterminate, never guessed", "rays meet only the piece's own faces"]},
             save=False, objects_out=rep)


L.run(main)
