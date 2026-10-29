"""shade_smooth — smooth shading BY ANGLE on named meshes: curved parts (tubes, rings, slings, rounded bevels, cushions) lose their visible facets, edges sharper than `angle_deg` stay crisp. Geometry is never changed (vertices, faces, UVs, materials untouched: the report proves it). Saves a checkpoint (not with dry_run).
How: every face is set smooth, and every edge whose two faces meet at more than `angle_deg` is marked SHARP; Blender (and the glTF export, which writes the resulting corner normals) then splits the normals there. `mode` "all" smooths everything with no sharp edges, "flat" undoes it.
params:
  objects       names or globs (default: none; give `objects` or `blockout_kinds`)
  blockout_kinds  e.g. ["tube", "ring", "sling", "wedge", "cluster"]: every object made by `blockout` of those kinds (its blockout_kind property)
  angle_deg     default 30 (30-40 keeps frames and box edges sharp and rounds tubes and bevels; a lower angle keeps more edges sharp)
  mode          "angle" (default) | "all" | "flat"
  dry_run       true: compute and report, change nothing
Refuses a mesh whose data is shared by objects that are not in the selection (that would change them too): make it single-user first, or select all its users.
Returns per object: polygons, sharp edges, the largest angle left smooth, the largest deviation of a corner normal from its face normal (deg), `geometry_unchanged`; totals.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import _shade as SH  # noqa: E402


def main():
    pats = L.param("objects") or []
    if isinstance(pats, str):
        pats = [pats]
    kinds = L.param("blockout_kinds") or []
    ang = float(L.param("angle_deg", 30))
    mode = L.param("mode", "angle")
    dry = bool(L.param("dry_run", False))
    sel = [o for o in bpy.context.scene.objects if o.type == "MESH" and ("blockout_kind" not in o or True) and (any(fnmatch.fnmatchcase(o.name, p) for p in pats) or (o.get("blockout_kind") in kinds))]
    if not sel:
        raise RuntimeError("nothing selected: give `objects` and/or `blockout_kinds`")
    rows, refused = [], []
    seen = set()
    users = {}
    for o in bpy.data.objects:
        if o.type == "MESH":
            users.setdefault(o.data, []).append(o)
    for o in sel:
        me = o.data
        if me in seen:
            continue
        others = [u.name for u in users.get(me, []) if u not in sel]
        if others:
            refused.append({"object": o.name, "why": f"its mesh is also used by {others[:3]}: make it single-user or select them too"})
            continue
        seen.add(me)
        if dry:
            tmp = me.copy()
            r = SH.smooth_by_angle(tmp, ang, mode)
            bpy.data.meshes.remove(tmp)
        else:
            r = SH.smooth_by_angle(me, ang, mode)
        rows.append({"object": o.name, **r})
    L.finish({"objects_changed": 0 if dry else len(rows), "mode": mode, "angle_deg": ang, "refused": refused, "all_geometry_unchanged": all(r["geometry_unchanged"] for r in rows),
              "sharp_edges_total": sum(r["sharp_edges"] for r in rows), "dry_run": dry}, save=not dry, rows=rows[:120])


L.run(main)
