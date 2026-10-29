"""uv_unwrap — give the one mesh a UV set.

params:
  mode           "keep_if_present" (default: a mesh with UVs keeps them — stock packs
                 map onto their own atlas) | "smart" (always re-unwrap)
  angle_limit    degrees, default 66
  island_margin  default 0.02
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    mesh = L.the_mesh()
    mode = L.param("mode", "keep_if_present")
    if mode == "keep_if_present" and len(mesh.data.uv_layers):
        L.finish({"skipped": True, "uv_layers": [u.name for u in mesh.data.uv_layers]}, save=True)
        return
    L.activate(mesh, "EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(float(L.param("angle_limit", 66))),
                             island_margin=float(L.param("island_margin", 0.02)))
    bpy.ops.object.mode_set(mode="OBJECT")
    L.finish({"uv_layers": [u.name for u in mesh.data.uv_layers]}, save=True)


L.run(main)
