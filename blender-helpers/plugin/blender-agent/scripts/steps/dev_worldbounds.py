"""dev_worldbounds — DEV helper: world position (origin) and world bounding box (mm) of the objects matching a glob, to test that nothing moves. params: objects (glob list, default ["*"])."""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def main():
    pats = L.param("objects", ["*"])
    bpy.context.view_layer.update()
    out = {}
    for o in sorted(bpy.data.objects, key=lambda x: x.name):
        if not any(fnmatch.fnmatchcase(o.name, p) for p in pats):
            continue
        if o.type == "MESH":
            pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
            bb = [[round(min(p[i] for p in pts) * 1000, 1) for i in range(3)], [round(max(p[i] for p in pts) * 1000, 1) for i in range(3)]]
        else:
            bb = None
        out[o.name] = {"origin_mm": [round(x * 1000, 1) for x in o.matrix_world.translation], "bounds_mm": bb, "parent": o.parent.name if o.parent else None, "rotation_deg": [round(__import__("math").degrees(x), 3) for x in o.rotation_euler], "hide_render": o.hide_render}
    L.finish({"objects": len(out), "world": out}, save=False)


L.run(main)
