"""decimate — collapse-decimate the one mesh to a triangle budget.

params:
  target_tris   required; a mesh already at or under budget is left as is
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    mesh = L.the_mesh()
    target = int(L.param("target_tris"))
    before = L.tris(mesh)
    if before <= target:
        L.finish({"skipped": True, "tris": before, "target_tris": target}, save=True)
        return
    L.activate(mesh)
    mod = mesh.modifiers.new("Decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = target / before
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    L.finish({"tris_before": before, "tris": L.tris(mesh), "target_tris": target}, save=True)


L.run(main)
