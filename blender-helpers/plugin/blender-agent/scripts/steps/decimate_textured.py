"""decimate_textured — reduce the triangles of selected static meshes IN PLACE, keeping each object's name, parent, origin, transform, materials and UVs (textures stay mapped). Nothing is merged. Saves a checkpoint (not with dry_run).

For heavy copied textured parts (fences, planting) that scene_optimize leaves alone. Collapse decimation moves vertices a little: the report gives, for the selection, how far the new surface lies from the old (mean / max, mm) and the change of every object's bounding box (mm), so the footprint is checked, not assumed.
Meshes that share one mesh datablock are reduced once and all their users get the result. Animated objects, lights, empties and `protect` names are never touched.
params:
  objects     name globs of the meshes to reduce (default: every static mesh that uses an image texture)
  budget_tris target triangles for the WHOLE selection (default 150000); the cut is a cap on any one mesh (water-filling), so big meshes lose most and small ones stay as they are
  ratio       instead of budget_tris: one ratio 0.02-1 for every selected mesh
  skip_alpha  true (default): leave meshes whose material cuts or blends by alpha (foliage cards, fence mesh) as they are: reducing them makes them striped and sparse (the bounding-box and deviation numbers do not show it); false: reduce them anyway
  min_tris    a mesh with fewer triangles than this is left as it is (default 40)
  protect     name globs never touched (default ["Louver_*", "Louvers_*", "*louver*", "bulb_*"])
  measure     true (default): surface deviation by nearest-point on a sample of up to 400 vertices per object; false: skip (faster)
  dry_run     true: the plan only (per object triangles before / after target), nothing changes
Returns: before / after triangles, objects reduced, per-object rows (largest 60), `max_bbox_change_mm`, `deviation_mm` (mean, max over sampled vertices), `materials_unchanged`, `uv_layers_unchanged`.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def has_image(o):
    return any(m and m.use_nodes and any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes) for m in o.data.materials)


def alpha_kind(o):
    """why a mesh counts as alpha: the blend mode of its materials ('CLIP', 'BLEND', 'HASHED') or 'alpha_linked' / 'alpha_below_1' on the Principled node; None = opaque"""
    for m in o.data.materials:
        if not m:
            continue
        bm = getattr(m, "blend_method", "OPAQUE")
        if m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == "BSDF_PRINCIPLED":
                    if n.inputs["Alpha"].is_linked:
                        return "alpha_linked/" + bm
                    if n.inputs["Alpha"].default_value < 0.999:
                        return "alpha_below_1/" + bm
        if bm in ("CLIP", "BLEND"):
            return "blend_method/" + bm
    return None


def has_alpha(o):
    """a material that cuts or blends by alpha (leaves, fence mesh): collapse decimation breaks such cards (striped, sparse), so they are skipped by default. A HASHED blend mode alone (the importer default) does not count."""
    return alpha_kind(o) is not None


def animated(o):
    ad = o.animation_data
    return bool(ad and (ad.action or ad.nla_tracks))


def bbox_world(o):
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    if not pts:
        return None
    return [min(p[i] for p in pts) for i in range(3)] + [max(p[i] for p in pts) for i in range(3)]


def main():
    dry = bool(L.param("dry_run", False))
    pats = L.param("objects")
    protect = L.param("protect") or ["Louver_*", "Louvers_*", "*louver*", "bulb_*"]
    min_t = int(L.param("min_tris", 40))
    scn = bpy.context.scene
    skip_alpha = bool(L.param("skip_alpha", True))
    skipped_alpha = []
    kinds = {}
    sel = []
    for o in scn.objects:
        if o.type != "MESH" or "blender_agent_marker" in o or animated(o):
            continue
        if any(fnmatch.fnmatchcase(o.name, p) for p in protect):
            continue
        if skip_alpha and has_alpha(o):
            skipped_alpha.append(o.name)
            kinds[alpha_kind(o)] = kinds.get(alpha_kind(o), 0) + 1
            continue
        if pats:
            if not any(fnmatch.fnmatchcase(o.name, p) for p in pats):
                continue
        elif not has_image(o):
            continue
        sel.append(o)
    if not sel:
        raise RuntimeError("nothing selected")
    datas = {}
    for o in sel:
        datas.setdefault(o.data, []).append(o)
    rows = [{"mesh": me, "users": len(os_), "t0": tris(me)} for me, os_ in datas.items()]
    total = sum(r["t0"] * r["users"] for r in rows)
    ratio = L.param("ratio")
    if ratio is not None:
        for r in rows:
            r["ratio"] = max(0.02, min(1.0, float(ratio)))
    else:
        budget = int(L.param("budget_tris", 150000))
        lo, hi = 0.0, float(max(r["t0"] for r in rows))
        for _ in range(60):
            mid = (lo + hi) / 2
            if sum(min(r["t0"], mid) * r["users"] for r in rows) > budget:
                hi = mid
            else:
                lo = mid
        for r in rows:
            r["ratio"] = 1.0 if total <= budget else max(0.02, min(1.0, lo / max(r["t0"], 1)))
    for r in rows:
        if r["t0"] < min_t:
            r["ratio"] = 1.0
        r["target"] = int(r["t0"] * r["ratio"])
    plan = {"skipped_alpha_objects": len(skipped_alpha), "skipped_alpha_kinds": kinds, "selected_objects": len(sel), "mesh_datablocks": len(rows), "triangles_before": total,
            "triangles_expected": sum(r["target"] * r["users"] for r in rows)}
    if dry:
        big = sorted(rows, key=lambda r: -r["t0"] * r["users"])[:60]
        L.finish({"dry_run": True, **plan}, save=False,
                 rows=[{"mesh": r["mesh"].name, "users": r["users"], "before": r["t0"], "target": r["target"]} for r in big])
        return
    bb0 = {o.name: bbox_world(o) for o in sel}
    measure = L.param("measure", True)
    dev_all, out_rows = [], []
    mat0 = {o.name: [m.name if m else None for m in o.data.materials] for o in sel}
    uv0 = {o.name: [u.name for u in o.data.uv_layers] for o in sel}
    for r in rows:
        me, os_ = r["mesh"], datas[r["mesh"]]
        if r["ratio"] >= 0.999:
            continue
        o = os_[0]
        bvh = None
        if measure:
            bvh = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [tuple(p.vertices) for p in me.polygons], all_triangles=False)
        mod = o.modifiers.new("DecimateTex", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = r["ratio"]
        mod.use_collapse_triangulate = True
        dg = bpy.context.evaluated_depsgraph_get()
        new = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        o.modifiers.remove(mod)
        if bvh is not None and len(new.vertices):
            step = max(1, len(new.vertices) // 400)
            d = [bvh.find_nearest(new.vertices[i].co)[3] for i in range(0, len(new.vertices), step)]
            dev_all.append((sum(d) / len(d), max(d)))
        new.name = me.name + "_dec"
        for u in os_:
            u.data = new
        r["t1"] = tris(new)
        if me.users == 0:
            bpy.data.meshes.remove(me)
        out_rows.append({"mesh": new.name, "users": r["users"], "before": r["t0"], "after": r["t1"]})
    bpy.context.view_layer.update()
    max_bb = 0.0
    for o in sel:
        a, b = bb0[o.name], bbox_world(o)
        if a and b:
            max_bb = max(max_bb, max(abs(x - y) for x, y in zip(a, b)))
    after = sum(tris(o.data) for o in sel)
    mats_ok = all([m.name if m else None for m in o.data.materials] == mat0[o.name] for o in sel)
    uv_ok = all([u.name for u in o.data.uv_layers] == uv0[o.name] for o in sel)
    out_rows.sort(key=lambda x: -x["before"] * x["users"])
    L.finish({"dry_run": False, **plan, "triangles_after": after, "objects_reduced": sum(r["users"] for r in out_rows),
              "max_bbox_change_mm": round(max_bb * 1000, 3),
              "deviation_mm": {"mean_of_means": round(1000 * sum(m for m, _ in dev_all) / len(dev_all), 3), "max": round(1000 * max(x for _, x in dev_all), 3)} if dev_all else None,
              "materials_unchanged": mats_ok, "uv_layers_unchanged": uv_ok}, save=True, rows=out_rows[:60])


L.run(main)
