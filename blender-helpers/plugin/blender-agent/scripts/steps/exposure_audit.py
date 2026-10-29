"""exposure_audit — READ-ONLY, whole scene: which SIDE of a surface can be seen from the outside? For sampled faces it asks, from exterior viewpoints and by open-air rays on both sides, whether the FRONT (the side a viewer sees) or only the BACK is exposed: the surfaces that "face away from the exposed area". Describes; it never decides intended facing and changes nothing. Saves nothing.

params:
  objects        names or globs of the surfaces to judge (default ["*"]: every mesh); everything render-visible in the scene blocks the rays
  viewpoints     optional list of [x, y, z] WORLD metres to look from (an interior is a valid choice). Default: rings of `ring_points` (16) points at each height of `eye_heights_m` ([1.6, 3.0]) above the scene's lowest point, at radius `ring_radius_m` (default 1.25 x the scene's half diagonal) around its centre
  per_piece      faces sampled per piece (default 2, spread evenly over the piece). When the scene has more than `max_faces / per_piece` pieces (default 20000 faces), only the LARGEST pieces by area are sampled; `pieces_not_sampled` and `area_not_sampled_share` say what was left out (raise `max_faces` or narrow `objects` to cover it)
  open_rays      default 6 rays per side, tilted `cone_deg` (default 35) from the face normal around it, plus the normal itself; "open" = nothing hit within `max_m` (default 30)
  weld_m         default 0: pieces are faces joined through shared vertices (as face_orient). With a value (0.0002), vertices that close together count as one, for imported meshes split at UV / normal seams (analysis only)
  faces          optional {"<object>": [face indices]}: these faces are always sampled (with their piece), e.g. faces another check already points at
  examples       default 3 example faces per flagged piece
  name           file stem of the full piece list in out/ (default exposure_audit)
Per sampled face: `seen_front` / `seen_back` (a viewpoint on that side of the face has a clear line to the face centre; grazing views under about 3 degrees are skipped), `front_open_share` / `back_open_share`, and the class:
  front_exposed      the front is seen / open, the back is not  (the normal case)
  back_exposed_only  the back is seen / open, the front is not  (faces away from the open: turned the wrong way, or an inner surface of a shell seen from outside)
  both_exposed       both sides can be seen (a free-standing sheet / card: fine if its material is double-sided)
  hidden             neither (inside a body or a wall)
Exposed = a viewpoint sees that side OR at least half of that side's open-air rays escape.
Per piece: faces, area of the sampled faces, class shares by area, world bounds, materials, `gltf_double_sided`, a verdict (the class holding at least half the sampled area, else "mixed"), examples. Also totals per object and per material. `flagged` = pieces whose verdict is `back_exposed_only`, biggest sampled area first.
Limits (stated so nobody reads more into it): geometry only (a cut-out's transparent part still blocks, and a transparent surface still counts as a wall); only SAMPLED faces are judged, so a piece with one turned face among many is seen only if a sample lands on it (use `face_orient` / `coplanar_audit` for that); a closed shell turned inside out shows up as `back_exposed_only`, an open sheet's verdict says which side the OUTSIDE can see, not which side was meant to face; thin double-layer geometry (a wall with both faces modelled) is judged per face, so its inner layer is `hidden` or `back_exposed_only` by design; the viewpoints decide what "outside" means: the default ring lies OUTSIDE the scene, and a hedge, fence or building between it and the site hides everything inside (most sampled faces then come out `hidden`): pass viewpoints ON the site (and in a room, for interiors); `viewpoints_first_seeing` shows which of your points see anything.
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


def pieces_of(me, wco, weld_m):
    nv = len(me.vertices)
    parent = list(range(nv))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    ed = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", ed)
    for a, b in ed.reshape(-1, 2):
        union(int(a), int(b))
    if weld_m > 0 and nv:
        from mathutils.kdtree import KDTree
        kd = KDTree(nv)
        for i in range(nv):
            kd.insert(Vector(wco[i]), i)
        kd.balance()
        for i in range(nv):
            for _, j, _d in kd.find_range(Vector(wco[i]), weld_m):
                union(i, j)
    return [find(i) for i in range(nv)]


def main():
    pats = L.param("objects") or ["*"]
    if isinstance(pats, str):
        pats = [pats]
    per_piece = int(L.param("per_piece", 2))
    max_faces = int(L.param("max_faces", 20000))
    n_open = int(L.param("open_rays", 6))
    cone = math.radians(float(L.param("cone_deg", 35)))
    max_m = float(L.param("max_m", 30))
    weld_m = float(L.param("weld_m", 0.0))
    nex = int(L.param("examples", 3))
    scn = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    allm = [o for o in scn.objects if o.type == "MESH" and not o.hide_render]
    sel = [o for o in allm if any(fnmatch.fnmatchcase(o.name, p) for p in pats)]
    if not sel:
        raise RuntimeError(f"no mesh matches {pats}")
    # scene extent for the default viewpoints
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for o in allm:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = np.minimum(lo, w)
            hi = np.maximum(hi, w)
    centre = (lo + hi) / 2
    vps = L.param("viewpoints")
    if vps:
        vps = [Vector(v) for v in vps]
    else:
        rad = float(L.param("ring_radius_m", 1.25 * float(np.linalg.norm(hi - lo)) / 2))
        npnt = int(L.param("ring_points", 16))
        vps = []
        for h in L.param("eye_heights_m", [1.6, 3.0]):
            for k in range(npnt):
                a = 2 * math.pi * k / npnt
                vps.append(Vector((centre[0] + rad * math.cos(a), centre[1] + rad * math.sin(a), lo[2] + float(h))))
    # first pass: pieces per object, to know how many faces we may afford
    plan = []
    total_pieces = 0
    for ob in sel:
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            nv = len(me.vertices)
            co = np.empty(nv * 3)
            me.vertices.foreach_get("co", co)
            mw = np.array(ev.matrix_world)
            wco = (mw[:3, :3] @ co.reshape(-1, 3).T).T + mw[:3, 3]
            root = pieces_of(me, wco, weld_m)
            lv = np.empty(len(me.loops), dtype=np.int64)
            me.loops.foreach_get("vertex_index", lv)
            faces_of = {}
            area_of = {}
            sc_ = abs(np.linalg.det(mw[:3, :3])) ** (2 / 3)
            for p in me.polygons:
                r_ = root[lv[p.loop_start]]
                faces_of.setdefault(r_, []).append(p.index)
                area_of[r_] = area_of.get(r_, 0.0) + p.area * sc_
            plan.append((ob, faces_of, area_of))
            total_pieces += len(faces_of)
        finally:
            ev.to_mesh_clear()
    # affordable work: keep the LARGEST pieces (by area) when there are more than max_faces / per_piece
    keep_n = max(1, max_faces // max(1, per_piece))
    skipped_pieces = 0
    skipped_area = 0.0
    total_area = sum(sum(a.values()) for _, _, a in plan) or 1e-12
    if total_pieces > keep_n:
        allp = sorted(((a_, id(o_), r_) for o_, f_, ar_ in plan for r_, a_ in ar_.items()), reverse=True)
        keep_set = {(i_, r_) for _, i_, r_ in allp[:keep_n]}
        new_plan = []
        for o_, f_, ar_ in plan:
            kept = {r_: v_ for r_, v_ in f_.items() if (id(o_), r_) in keep_set}
            skipped_pieces += len(f_) - len(kept)
            skipped_area += sum(a_ for r_, a_ in ar_.items() if (id(o_), r_) not in keep_set)
            new_plan.append((o_, kept, ar_))
        plan = new_plan
    det_cache = {}
    results = []
    ray_count = 0
    vp_first = [0] * len(vps)
    for ob, faces_of, _ar in plan:
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            mw = np.array(ev.matrix_world)
            M3it = np.linalg.inv(mw[:3, :3]).T
            nv = len(me.vertices)
            co = np.empty(nv * 3)
            me.vertices.foreach_get("co", co)
            wco = (mw[:3, :3] @ co.reshape(-1, 3).T).T + mw[:3, 3]
            mats = [m.name if m else None for m in me.materials]
            dbl = [(not bool(getattr(m, "use_backface_culling", False))) if m else None for m in me.materials]
            for root, fids in faces_of.items():
                k = max(1, per_piece)
                idxs = sorted({fids[int(round(i * (len(fids) - 1) / max(1, k - 1)))] for i in range(k)}) if len(fids) > 1 and k > 1 else [fids[len(fids) // 2]]
                forced = [f_ for f_ in (L.param("faces") or {}).get(ob.name, []) if f_ in set(fids)]
                if forced:
                    idxs = sorted(set(idxs) | set(int(x) for x in forced))
                allpts = wco[sorted({v for fi in fids for v in me.polygons[fi].vertices})]
                faces = []
                for fi in idxs:
                    poly = me.polygons[fi]
                    area_w = poly.area * abs(np.linalg.det(mw[:3, :3])) ** (2 / 3)
                    c = Vector(wco[list(poly.vertices)].mean(axis=0))
                    n = Vector(M3it @ np.array(poly.normal)).normalized()
                    u = n.cross(Vector((1, 0, 0)) if abs(n.x) < 0.8 else Vector((0, 1, 0))).normalized()
                    v = n.cross(u)
                    seen = {"front": False, "back": False}
                    for vi_, vp in enumerate(vps):
                        d = vp - c
                        dist = d.length
                        if dist < 1e-6:
                            continue
                        dn = d.dot(n) / dist
                        if abs(dn) < 0.05:
                            continue
                        side = "front" if dn > 0 else "back"
                        if seen[side]:
                            continue
                        o = c + n * (2e-3 if dn > 0 else -2e-3)
                        dd = (vp - o)
                        ray_count += 1
                        hit = scn.ray_cast(dg, o, dd.normalized(), distance=dd.length - 1e-3)[0]
                        if not hit:
                            seen[side] = True
                            vp_first[vi_] += 1
                    openshare = {}
                    for side, sg in (("front", 1.0), ("back", -1.0)):
                        dirs = [n * sg]
                        for j in range(n_open):
                            a = 2 * math.pi * j / max(1, n_open)
                            dirs.append((n * sg * math.cos(cone) + (u * math.cos(a) + v * math.sin(a)) * math.sin(cone)).normalized())
                        free = 0
                        for dvec in dirs:
                            ray_count += 1
                            if not scn.ray_cast(dg, c + n * sg * 2e-3, dvec, distance=max_m)[0]:
                                free += 1
                        openshare[side] = free / len(dirs)
                    ef = seen["front"] or openshare["front"] >= 0.5
                    eb = seen["back"] or openshare["back"] >= 0.5
                    cls = "both_exposed" if ef and eb else ("front_exposed" if ef else ("back_exposed_only" if eb else "hidden"))
                    mi = poly.material_index
                    faces.append({"face": int(fi), "class": cls, "area_m2": round(area_w, 6), "centre_m": [round(x, 3) for x in c], "normal": [round(x, 3) for x in n],
                                  "seen_front": seen["front"], "seen_back": seen["back"], "front_open_share": round(openshare["front"], 3), "back_open_share": round(openshare["back"], 3),
                                  "material": mats[mi] if mi < len(mats) else None, "gltf_double_sided": dbl[mi] if mi < len(dbl) else None})
                tot = sum(f["area_m2"] for f in faces) or 1e-12
                shares = {}
                for f in faces:
                    shares[f["class"]] = shares.get(f["class"], 0) + f["area_m2"] / tot
                top = max(shares.items(), key=lambda kv: kv[1])
                verdict = top[0] if top[1] >= 0.5 else "mixed"
                results.append({"object": ob.name, "faces_in_piece": len(fids), "sampled_faces": len(faces), "sampled_area_m2": round(tot, 5),
                                "class_share": {k_: round(v_, 3) for k_, v_ in shares.items()}, "verdict": verdict,
                                "bounds_m": [[round(float(x), 3) for x in allpts.min(axis=0)], [round(float(x), 3) for x in allpts.max(axis=0)]],
                                "materials": sorted({f["material"] for f in faces if f["material"]})[:4],
                                "gltf_double_sided": (True if any(f["gltf_double_sided"] for f in faces) else (False if all(f["gltf_double_sided"] is False for f in faces) else None)),
                                "faces": faces})
        finally:
            ev.to_mesh_clear()
    by_obj, by_mat = {}, {}
    for r in results:
        o = by_obj.setdefault(r["object"], {"pieces": 0, "sampled_area_m2": 0.0, "area_by_class": {}})
        o["pieces"] += 1
        for f in r["faces"]:
            o["sampled_area_m2"] += f["area_m2"]
            o["area_by_class"][f["class"]] = o["area_by_class"].get(f["class"], 0.0) + f["area_m2"]
            m = by_mat.setdefault(f["material"], {"sampled_faces": 0, "area_by_class": {}, "gltf_double_sided": f["gltf_double_sided"]})
            m["sampled_faces"] += 1
            m["area_by_class"][f["class"]] = m["area_by_class"].get(f["class"], 0.0) + f["area_m2"]
    for dct in (by_obj, by_mat):
        for v in dct.values():
            v["area_by_class"] = {k: round(x, 4) for k, x in v["area_by_class"].items()}
            if "sampled_area_m2" in v:
                v["sampled_area_m2"] = round(v["sampled_area_m2"], 4)
    flagged = sorted((r for r in results if r["verdict"] == "back_exposed_only"), key=lambda r: -r["sampled_area_m2"])
    name = L.param("name", "exposure_audit")
    outd = L.ARGS.get("out_dir")
    full = None
    if outd:
        os.makedirs(outd, exist_ok=True)
        full = os.path.join(outd, name + ".json")
        with open(full, "w", encoding="utf-8") as fh:
            json.dump(results, fh)

    def slim(r):
        s = {k: v for k, v in r.items() if k != "faces"}
        s["examples"] = [{k: f[k] for k in ("face", "class", "centre_m", "normal", "material", "seen_front", "seen_back", "front_open_share", "back_open_share")} for f in r["faces"][:nex]]
        return s
    counts = {}
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    L.finish({"objects": len(plan), "pieces": len(results), "faces_sampled": sum(r["sampled_faces"] for r in results), "per_piece_used": per_piece, "pieces_in_scene": total_pieces, "pieces_not_sampled": skipped_pieces, "area_not_sampled_share": round(skipped_area / total_area, 5),
              "viewpoints": len(vps), "viewpoints_first_seeing": [{"point_m": [round(x, 2) for x in v_], "sides_seen": n_} for v_, n_ in zip(vps, vp_first)], "rays_cast": ray_count, "pieces_by_verdict": counts,
              "flagged_pieces": len(flagged), "flagged_area_m2": round(sum(r["sampled_area_m2"] for r in flagged), 4),
              "full_list_file": full, "weld_m": weld_m, "max_m": max_m,
              "notes": ["read-only; geometry only (alpha ignored); sampled faces, not all faces; describes exposure, never intended facing"]},
             save=False, by_object=by_obj, by_material=by_mat, flagged=[slim(r) for r in flagged[:200]])


L.run(main)
