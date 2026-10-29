"""dev_shadowmat — DEV TOOL (read-only): for objects matching `objects` (globs), their shadow-ray relevant state: visible_shadow, hide_render, and per material the nodes that let a Cycles shadow ray through (Principled Alpha / Transmission Weight, Transparent BSDF, mix shaders, Alpha texture links), plus the object's bounding box in world metres."""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def mat_info(m):
    if not m:
        return {"material": None}
    out = {"material": m.name, "use_nodes": m.use_nodes, "blend_method": getattr(m, "blend_method", None), "nodes": []}
    if not m.use_nodes:
        return out
    for n in m.node_tree.nodes:
        d = {"type": n.type}
        if n.type == "BSDF_PRINCIPLED":
            a, t = n.inputs["Alpha"], n.inputs["Transmission Weight"]
            d.update(alpha=round(a.default_value, 4), alpha_linked=a.is_linked, transmission=round(t.default_value, 4), transmission_linked=t.is_linked)
        elif n.type in ("BSDF_TRANSPARENT", "BSDF_GLASS", "BSDF_TRANSLUCENT", "MIX_SHADER", "ADD_SHADER", "BSDF_REFRACTION", "HOLDOUT"):
            pass
        else:
            continue
        out["nodes"].append(d)
    return out


def main():
    globs = L.param("objects") or ["*Lava*", "*Fill*", "*Firetray*"]
    rows = []
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, g) for g in globs):
            from mathutils import Vector
            bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
            rows.append({"object": o.name, "tris": len(o.data.polygons), "visible_shadow": o.visible_shadow, "hide_render": o.hide_render, "visible_camera": o.visible_camera, "visible_diffuse": o.visible_diffuse,
                         "bbox_blender_min": [round(min(v[i] for v in bb), 3) for i in range(3)], "bbox_blender_max": [round(max(v[i] for v in bb), 3) for i in range(3)], "materials": [mat_info(sl.material) for sl in o.material_slots]})
    L.finish({"count": len(rows), "rows": rows[:60]}, save=False)


L.run(main)
