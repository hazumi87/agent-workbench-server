"""foliage_normals — give foliage CARDS (cut-out planes with a leaf or conifer picture) soft, tree-like shading instead of the flat per-plane shading that makes crossed cards show a bright half and a dark half and hard seams. Each corner normal is pointed away from the tree's axis (or centre) and tilted up by `up_bias`, so a whole crown shades like one rounded mass; the picture, UVs, geometry and materials are untouched. Saves a checkpoint (not with dry_run).
How: custom split normals (written by the glTF export as the mesh's NORMAL attribute): for each corner, n = normalize((corner - axis point) in the XY plane or in 3D, plus `up_bias` * up). Cards are usually double-sided: Blender flips the normal on the back face when rendering, a runtime that does the same needs no change; one that does not will light the back of a card with this normal too, which is what you want for a soft crown.
params:
  objects     names or globs of the card meshes (required)
  single_user false (default): a mesh whose data is shared with ANY other object (linked scene_instance copies, a crossed pair sharing one mesh) is refused, nothing changes. true: every selected object that shares its mesh gets its OWN copy first (the objects outside the selection keep the original, unchanged); needed because linked copies at different places/rotations cannot each have their own outward normals. Cost: the GLB then writes each copied mesh separately (more triangles in the file); materials and textures stay shared
  mode        "reset": UNDO a previous run: an object whose mesh was copied by `single_user` goes back to the ORIGINAL shared mesh (found by the `foliage_normals_source_mesh` property, or, for a copy made before the property existed, by the name without its ".001" suffix) and the copy is deleted; any other object just has its custom normals cleared. Report `restored` / `cleared` per object. The earlier checkpoint also still has the original state.
              "axis" (default: away from a vertical line through each object's own bounding-box centre; right for a column / tree) | "point" (away from a 3D point, `centre`; right for a round bush) | "world_up" (every normal straight up: flat, even lighting)
  centre      [x, y, z] world metres for mode "point"; with mode "axis" an optional [x, y] to use ONE axis for all the objects (a tree made of several objects) instead of each object's own
  centre_to   [x, y] (mode axis, with `centre`): the axis becomes the vertical PLANE through the segment centre -> centre_to, so a long row (a hedge) shades away from its own length line, not from one point (normals at the ends would otherwise lean along the row)
  up_bias     0 to 1, default 0.3: how far the normal tilts towards +Z (more = lighter top, softer sides)
  dry_run     true: the plan only
Returns per object: corners set (and `meshes_copied_to_single_user`), mean angle between the new normal and the old one (deg), the axis / point used; `geometry_unchanged`.
Limits: shading only: no texture change, no silhouette change; edge-on cards (a crossed-plane pair seen from the side) still show as thin slivers because the plane is thin.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def main():
    pats = L.param("objects") or []
    if isinstance(pats, str):
        pats = [pats]
    if not pats:
        raise RuntimeError("objects: name the card meshes (globs allowed)")
    mode = L.param("mode", "axis")
    if mode not in ("axis", "point", "world_up", "reset"):
        raise RuntimeError('mode: "axis" | "point" | "world_up" | "reset"')
    up = float(L.param("up_bias", 0.3))
    cen = L.param("centre")
    dry = bool(L.param("dry_run", False))
    if mode == "point" and not cen:
        raise RuntimeError('mode "point" needs centre [x, y, z]')
    sel = [o for o in bpy.context.scene.objects if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, p) for p in pats)]
    if not sel:
        raise RuntimeError(f"no mesh matches {pats}")
    single = bool(L.param("single_user", False))
    rows, refused, copied = [], [], []
    if mode == "reset":
        import re
        for o in sel:
            me = o.data
            orig = bpy.data.meshes.get(o.get("foliage_normals_source_mesh", "") or re.sub(r"\.\d{3}$", "", me.name))
            if orig is not None and orig != me:
                rows.append({"name": o.name, "action": "restored", "mesh_back_to": orig.name, "copy_removed": me.name})
                if not dry:
                    o.data = orig
                    if o.get("foliage_normals_source_mesh"):
                        del o["foliage_normals_source_mesh"]
                    if me.users == 0:
                        bpy.data.meshes.remove(me)
            else:
                rows.append({"name": o.name, "action": "cleared", "had_custom_normals": bool(me.has_custom_normals)})
                if not dry and me.has_custom_normals:
                    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
                        bpy.ops.mesh.customdata_custom_splitnormals_clear()
        L.finish({"dry_run": dry, "objects": len(rows), "mode": "reset"}, save=not dry, rows=rows[:100])
        return
    for o in sel:
        me = o.data
        if me.users > 1:
            if not single:
                refused.append({"name": o.name, "why": f"mesh data shared with {me.users - 1} other object(s): pass \"single_user\": true to give the selected objects their own copy"})
                continue
            if not dry:
                o["foliage_normals_source_mesh"] = me.name
                o.data = me.copy()
                me = o.data
            copied.append(o.name)
        n = len(me.loops)
        if n == 0:
            continue
        vi = np.empty(n, dtype=np.int32)
        me.loops.foreach_get("vertex_index", vi)
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        M = np.array(o.matrix_world)
        w = (co @ M[:3, :3].T) + M[:3, 3]
        pw = w[vi]
        if mode == "world_up":
            d = np.zeros_like(pw)
            d[:, 2] = 1.0
            used = "world up"
        else:
            if mode == "point":
                c = np.array(cen, float)
                d = pw - c
                used = [round(float(x), 3) for x in c]
            else:
                if cen:
                    cx, cy = float(cen[0]), float(cen[1])
                else:
                    lo, hi = w.min(0), w.max(0)
                    cx, cy = float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2)
                to = L.param("centre_to")
                if cen and to:
                    a, b = np.array([cx, cy]), np.array([float(to[0]), float(to[1])])
                    ab = b - a
                    t = np.clip(((pw[:, :2] - a) @ ab) / max(float(ab @ ab), 1e-9), 0, 1)
                    near = a + t[:, None] * ab
                    d = np.zeros_like(pw)
                    d[:, :2] = pw[:, :2] - near
                    used = [[round(cx, 3), round(cy, 3)], [round(float(b[0]), 3), round(float(b[1]), 3)]]
                else:
                    d = pw - np.array([cx, cy, 0.0])
                    d[:, 2] = 0.0
                    used = [round(cx, 3), round(cy, 3)]
            ln = np.linalg.norm(d, axis=1, keepdims=True)
            d = np.where(ln > 1e-6, d / np.maximum(ln, 1e-9), np.array([0.0, 0.0, 1.0]))
            d = d + np.array([0.0, 0.0, up])
        d = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        nl = d @ M[:3, :3]   # world -> local (the rotation part is orthonormal for cards; a scale only changes length)
        nl = nl / np.maximum(np.linalg.norm(nl, axis=1, keepdims=True), 1e-9)
        old = np.empty(n * 3)
        me.loops.foreach_get("normal", old)
        old = old.reshape(-1, 3)
        ang = float(np.degrees(np.arccos(np.clip((old * nl).sum(1), -1, 1))).mean())
        rows.append({"name": o.name, "corners": n, "mean_change_deg": round(ang, 1), "axis_or_point": used})
        if not dry:
            me.normals_split_custom_set(nl.tolist())
    if not rows:
        raise RuntimeError(f"nothing changed; refused: {refused}")
    L.finish({"dry_run": dry, "objects": len(rows), "mode": mode, "up_bias": up, "geometry_unchanged": True, "meshes_copied_to_single_user": copied[:100]}, save=not dry, rows=rows[:100], refused=refused[:50])


L.run(main)
