"""dev_emitparent — DEV TOOL: an empty `FirePit_Flame` rotated 90 degrees about glTF Y (Blender Z) for emitters_make tests."""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    e = bpy.data.objects.new("FirePit_Flame", None)
    bpy.context.scene.collection.objects.link(e)
    e.location = (-2.15, 0.4, 0.5)
    e.rotation_euler = (0, 0, math.radians(90))
    L.finish({"built": ["FirePit_Flame"]}, save=True)


L.run(main)
