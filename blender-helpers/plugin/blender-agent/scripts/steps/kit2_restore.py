"""kit2_restore — put one part back to its state in an earlier checkpoint, so a failed fix can be redone on that part only.

params:
  from_blend   .blend of the earlier checkpoint
  objects      names to replace (each is removed from this scene, then appended from the checkpoint)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    names = L.param("objects")
    path = L.resolve(L.param("from_blend"))
    for n in names:
        if n in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = [n for n in src.objects if n in names]
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
    L.finish({"restored": [o.name for o in dst.objects], "tris": {o.name: L.tris(o) for o in dst.objects}}, save=True)


L.run(main)