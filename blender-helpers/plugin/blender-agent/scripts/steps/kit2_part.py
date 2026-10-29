"""kit2_part — step 3 of character-kit-assembly: place ONE part (or a left/right pair) on the REFERENCE.

The body is not used here. The part is welded, fitted to where the reference wears it (trimmed ICP with
per-axis scale + translation; front/back and mirror chosen by the fit), decimated to its budget, checked,
and the .blend is saved as that part's checkpoint.

params:
  name     part name (objects become name, or name_L / name_R for a pair; +X is the character's left)
  id       Library mesh id
  c, size  expected centre and size of the part on the reference, metres (a starting box for the fit)
  pair     true -> two copies, each fitted to its own side of the reference
  rots     allowed 180-degree turns about Z, default [false, true]  (a ring can fit equally well turned round)
  mirrors  allowed X-mirrors (pairs), default [false, true]
  budget   triangle budget
  scale_mode  "uniform" (DEFAULT: ONE scale for all axes, the part keeps its own proportions), "axis" (one scale per axis, fitted:
              only when asked for; proportions may change), "fixed" (keep the starting per-axis scale, only move)
  touch    name of a part this one sits on: it is slid back (+Y) until it touches it, then sunk 3 mm. The contact is then
           MEASURED over the whole face turned to the host (not the nearest point): median and worst (95th percentile) gap, and the
           step FAILS (nothing saved) when the median is above touch_max_median_mm (default 6) or the worst above
           touch_max_worst_mm (default 20). touch_check:false reports without failing.
Whenever the part's width:height:depth ends up more than 5% off its own, the result carries a `warnings` entry with the percentages.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def contact(o, host, host_bvh):
    """the gap between the face of `o` that turns toward `host` and the host's surface, over that whole face: for each sampled vertex
    of `o` within 40 mm of the host, with a clear line to the nearest host point (nothing of `o` in between)."""
    v = K.sample(K.verts(o), 4000)
    part_bvh = K.bvh_of(o)
    gaps = []
    for p in v:
        P = Vector(p)
        loc, nrm, _, dist = host_bvh.find_nearest(P)
        if loc is None or dist > 0.04:
            continue
        dirn = (loc - P)
        if dist > 2e-4 and part_bvh.ray_cast(P + dirn.normalized() * 1e-4, dirn.normalized(), dist - 2e-4)[0] is not None:
            continue  # the far side of the part: its own body is in the way
        gaps.append(dist)
    if not gaps:
        return {"n_contact_points": 0, "median_gap_mm": None, "worst_gap_mm": None, "max_gap_mm": None}
    g = np.array(gaps)
    return {"n_contact_points": int(len(g)), "median_gap_mm": K.mm(np.median(g)), "worst_gap_mm": K.mm(np.percentile(g, 95)), "max_gap_mm": K.mm(g.max()),
            "min_gap_mm": K.mm(g.min())}


def main():
    name = L.param("name")
    ref = L.ref_object()
    rv = K.verts(ref)
    ref_tree = K.kd(rv)
    ref_bvh = K.bvh_of(ref)
    c, size = L.param("c"), L.param("size")
    sides = [1, -1] if L.param("pair") else [0]
    rots = L.param("rots", [False, True])
    mirrors = L.param("mirrors", [False, True]) if L.param("pair") else [False]
    mode = L.param("scale_mode", "uniform")
    if mode not in ("axis", "uniform", "fixed"):
        raise RuntimeError(f"scale_mode must be axis, uniform or fixed, not {mode}")
    report = {"name": name, "scale_mode": mode, "sides": {}, "warnings": []}
    objs = {}
    fits = {}
    for sd in sides:
        o = K.import_glb(K.lib(L.param("id")), (f"{name}_{'L' if sd > 0 else 'R'}" if sd else name))
        K.weld(o)
        src = K.verts(o)
        cc = [sd * c[0] if sd else c[0], c[1], c[2]]
        best, tried = None, []
        for rot in rots:
            for mir in mirrors:
                f = K.fit_part(src, rv, cc, size, rot, mir, fix_scale=bool(L.param("fix_scale", False)) or mode == "fixed", uniform=mode == "uniform")
                if f:
                    tried.append([bool(rot), bool(mir), K.mm(f["resid"])])
                    if best is None or f["resid"] < best["resid"]:
                        best = f
        if best is None:
            raise RuntimeError(f"{name}: no reference points near the expected spot")
        K.apply_fit(o, src, best)
        prop_after = K.proportions(K.verts(o))
        prop_native = K.proportions(src)
        before, after = K.decimate(o, int(L.param("budget")))
        objs[sd], fits[sd] = o, best
        w = K.proportion_warning(o.name, prop_native, prop_after)
        if w:
            report["warnings"].append(w)
        report["sides"][str(sd)] = {"object": o.name, "fit_scale": [round(float(x), 4) for x in best["s"]],
                                    "fit_error_mm": K.mm(best["resid"]), "rot180": best["rot180"], "mirror": best["mirror"],
                                    "tried_rot_mirror_err": tried, "tris": [before, after],
                                    "proportions_before": prop_native, "proportions_after": prop_after,
                                    "proportion_change_pct": K.proportion_change_pct(prop_native, prop_after)}
    touch = L.param("touch")
    if touch:
        tb = K.bvh_of(bpy.data.objects[touch])
        for sd, o in objs.items():
            v = K.verts(o)
            best = None
            for p in v[:: max(1, len(v) // 2500)]:
                hit = tb.ray_cast(Vector(p), Vector((0, 1, 0)), 0.2)
                if hit[0] is not None and (best is None or hit[3] < best):
                    best = hit[3]
            move = max(0.0, (best or 0.0) - 0.003) if (best or 1.0) < 0.1 else 0.0
            v[:, 1] += move
            K.set_verts(o, v)
            report["sides"][str(sd)]["slid_back_mm"] = K.mm(move)
            bpy.context.view_layer.update()
            report["sides"][str(sd)]["to_" + touch] = contact(o, bpy.data.objects[touch], tb)
        fails = []
        for sd, o in objs.items():
            ct = report["sides"][str(sd)]["to_" + touch]
            if ct["n_contact_points"] < 20:
                fails.append(f"{o.name}: only {ct['n_contact_points']} points of its face toward {touch} are within 40 mm of it: it does not touch")
            elif ct["median_gap_mm"] > float(L.param("touch_max_median_mm", 6)) or ct["worst_gap_mm"] > float(L.param("touch_max_worst_mm", 20)):
                fails.append(f"{o.name}: gap to {touch} over the contact face: median {ct['median_gap_mm']} mm (limit {L.param('touch_max_median_mm', 6)}), "
                             f"worst 95th percentile {ct['worst_gap_mm']} mm (limit {L.param('touch_max_worst_mm', 20)}), max {ct['max_gap_mm']} mm")
        report["touch_ok"] = not fails
        if fails and L.param("touch_check", True):
            raise RuntimeError("touch check failed: " + "; ".join(fails) + ". Adjust c/size or scale_mode, or set touch_check:false to look at it anyway")
    bpy.context.view_layer.update()
    for sd, o in objs.items():
        v = K.verts(o)
        sm = K.sample(v, 2500)
        d = np.abs(K.surf_signed(ref_bvh, sm))
        idx, dd = K.nearest(ref_tree, sm)
        region = rv[idx[dd < 0.006]]
        e = report["sides"][str(sd)]
        e["checks"] = K.mesh_checks(o)
        e["part_size_mm"] = [round(x * 1000) for x in K.size_of(v)]
        e["ref_region_size_mm"] = [round(x * 1000) for x in K.size_of(region)] if len(region) > 50 else None
        e["part_centre_m"] = K.centre_of(v)
        e["distance_to_reference_mm"] = {"median": K.mm(np.median(d)), "p95": K.mm(np.percentile(d, 95))}
    if len(objs) == 2:
        a, b = K.verts(objs[1]), K.verts(objs[-1])
        am = a * np.array([-1.0, 1.0, 1.0])
        _, dd = K.nearest(K.kd(b), K.sample(am, 3000, 4))
        report["LR_difference"] = {"mirror_vs_other_median_mm": K.mm(np.median(dd)), "p95_mm": K.mm(np.percentile(dd, 95)),
                                   "size_L_mm": [round(x * 1000) for x in K.size_of(a)],
                                   "size_R_mm": [round(x * 1000) for x in K.size_of(b)]}
    L.finish(report, save=True)


L.run(main)