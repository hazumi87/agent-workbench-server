"""kit2_addbody — append the fitted body from another job step's .blend into this scene (the parts are already here).

params:
  from_blend   path to the .blend that holds the object `body` (e.g. the kit2_body checkpoint)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    path = L.resolve(L.param("from_blend"))
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = [n for n in src.objects if n == "body"]
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
    L.finish({"added": [o.name for o in dst.objects], "body_tris": L.tris(bpy.data.objects["body"])}, save=True)


L.run(main)