"""dev_listnames — DEV TOOL, read-only: object / material / image names matching `match` (regexes, default none = counts only), with triangle counts and sizes. Saves nothing."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    pats = [re.compile(p, re.I) for p in (L.param("match") or [])]
    objs = []
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and any(p.search(o.name) for p in pats):
            me = o.data
            me.calc_loop_triangles()
            objs.append({"name": o.name, "tris": len(me.loop_triangles), "users": me.users, "parent": o.parent.name if o.parent else None, "materials": [m.name if m else None for m in me.materials][:4], "uv_layers": [u.name for u in me.uv_layers], "custom_normals": bool(me.has_custom_normals)})
    imgs = [{"name": i.name, "size": list(i.size), "packed": bool(i.packed_file), "path": i.filepath} for i in bpy.data.images if any(p.search(i.name) for p in pats)]
    mats = [m.name for m in bpy.data.materials if any(p.search(m.name) for p in pats)]
    L.finish({"objects_total": len(bpy.context.scene.objects), "matched_objects": len(objs)}, save=False, objects=objs[:120], images=imgs, materials=mats)


L.run(main)
