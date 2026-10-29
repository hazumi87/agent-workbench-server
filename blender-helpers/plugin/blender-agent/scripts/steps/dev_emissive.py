"""dev_emissive — DEV TOOL (read-only): render-visible mesh objects whose materials emit light in Cycles (Principled emission strength > 0 with a non-black colour, or an Emission shader), with strength and colour."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def emits(m):
    out = []
    if not m or not m.use_nodes:
        return out
    for n in m.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            s, c = n.inputs["Emission Strength"], n.inputs["Emission Color"]
            if s.default_value > 0 and (c.is_linked or max(c.default_value[:3]) > 0.0):
                out.append({"node": "principled", "strength": round(s.default_value, 4), "colour": [round(v, 3) for v in c.default_value[:3]], "colour_linked": c.is_linked, "strength_linked": s.is_linked})
        elif n.type == "EMISSION":
            st = n.inputs["Strength"].default_value
            out.append({"node": "emission", "strength": round(st, 4), "colour": [round(v, 3) for v in n.inputs["Color"].default_value[:3]], "colour_linked": n.inputs["Color"].is_linked})
    return out


def main():
    rows = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or o.hide_render:
            continue
        em = []
        for sl in o.material_slots:
            for e in emits(sl.material):
                em.append({"material": sl.material.name, **e})
        if em:
            rows.append({"object": o.name, "tris": len(o.data.polygons), "emission": em})
    L.finish({"emissive_objects": len(rows), "rows": rows[:80], "world_strength": bpy.context.scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value if bpy.context.scene.world and bpy.context.scene.world.use_nodes else None}, save=False)


L.run(main)
