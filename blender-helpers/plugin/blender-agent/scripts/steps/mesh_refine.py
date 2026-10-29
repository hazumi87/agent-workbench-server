"""mesh_refine — ROUND OFF selected meshes: subdivide them smoothly (Catmull-Clark) and shade them smooth, keeping each object's name, transform, parent, materials and material slots, so a coarse angular shape (a faceted bulb, a pebble) gets a rounded silhouette. Saves a checkpoint (not with dry_run).
How: a Subdivision Surface is applied on a temporary basis and its result replaces the object's mesh (the old mesh is removed when nothing else uses it). Catmull-Clark shrinks a coarse shape toward its inside, so by default the result is scaled back, per axis about the middle of its bounding box, to the ORIGINAL bounding box (`keep_size`): the overall size and the object's origin stay, only the surface between the corners is rounder.
params:
  objects     names / globs of the meshes (required)
  levels      1 (default) | 2 | 3: each level multiplies the triangle count by about 4
  keep_size   true (default): scale the result back to the original bounding box; false: leave the natural shrink
  smooth      true (default): shade the result smooth
  single_user false (default): a mesh shared with another object is refused; true: the selected objects get their own copies of the mesh first
  dry_run     true: report only
Returns per object: polygons before / after, bounding box size before / after (mm), `materials_kept` (the slot materials by name, equal before and after).
Limits: UV layers are carried through the subdivision (interpolated); vertex groups, shape keys and custom normals are not preserved; a mesh with sharp creases is not given any: the result is soft everywhere (use shade_smooth angle rules afterwards only for shading).
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def bbox(me):
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    return co.min(0), co.max(0)


def main():
    pats = L.param("objects") or []
    if isinstance(pats, str):
        pats = [pats]
    if not pats:
        raise RuntimeError("objects: name the meshes (globs allowed)")
    levels = max(1, min(int(L.param("levels", 1)), 3))
    keep = bool(L.param("keep_size", True))
    smooth = bool(L.param("smooth", True))
    single = bool(L.param("single_user", False))
    dry = bool(L.param("dry_run", False))
    sel = [o for o in bpy.context.scene.objects if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, p) for p in pats)]
    if not sel:
        raise RuntimeError(f"no mesh matches {pats}")
    dg = bpy.context.evaluated_depsgraph_get()
    rows, refused = [], []
    for o in sel:
        me = o.data
        if me.users > 1 and not single:
            refused.append({"name": o.name, "why": f"mesh shared with {me.users - 1} other object(s): pass single_user true"})
            continue
        mats_before = [m.name if m else None for m in me.materials]
        lo0, hi0 = bbox(me)
        n0 = len(me.polygons)
        if dry:
            rows.append({"name": o.name, "polygons_before": n0, "polygons_after_estimate": n0 * 4 ** levels, "size_mm_before": [round(float(x) * 1000, 2) for x in (hi0 - lo0)]})
            continue
        mod = o.modifiers.new("mesh_refine", "SUBSURF")
        mod.subdivision_type = "CATMULL_CLARK"
        mod.levels = levels
        mod.render_levels = levels
        dg.update()
        newme = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        o.modifiers.remove(mod)
        if keep and len(newme.vertices):
            lo1, hi1 = bbox(newme)
            co = np.empty(len(newme.vertices) * 3)
            newme.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            s = np.where((hi1 - lo1) > 1e-9, (hi0 - lo0) / np.maximum(hi1 - lo1, 1e-12), 1.0)
            co = (co - (lo1 + hi1) / 2) * s + (lo0 + hi0) / 2
            newme.vertices.foreach_set("co", co.ravel())
            newme.update()
        if smooth:
            newme.polygons.foreach_set("use_smooth", [True] * len(newme.polygons))
        name = me.name
        old = me
        if single and old.users > 1:
            old.name = name + ".old"
        o.data = newme
        newme.name = name if old.users == 0 else name + ".refined"
        if old.users == 0:
            old.name = name + ".old"
            newme.name = name
            bpy.data.meshes.remove(old)
        lo2, hi2 = bbox(newme)
        rows.append({"name": o.name, "polygons_before": n0, "polygons_after": len(newme.polygons), "size_mm_before": [round(float(x) * 1000, 2) for x in (hi0 - lo0)],
                     "size_mm_after": [round(float(x) * 1000, 2) for x in (hi2 - lo2)], "materials_kept": mats_before == [m.name if m else None for m in newme.materials], "materials": mats_before})
    if not rows:
        raise RuntimeError(f"nothing refined; refused: {refused}")
    L.finish({"dry_run": dry, "objects": len(rows), "levels": levels, "keep_size": keep}, save=not dry, rows=rows[:100], refused=refused[:50])


L.run(main)
