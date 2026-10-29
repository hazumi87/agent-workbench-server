"""dev_extrasfix — DEV TOOL: an empty `FirePit_Flame` with two child empties and a sibling cube carrying its own custom property, for node_extras / export_scene tests."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    L.drop_factory_objects()
    root = bpy.data.objects.new("FirePit_Flame", None)
    root.empty_display_type = "PLAIN_AXES"
    bpy.context.scene.collection.objects.link(root)
    root.location = (1, 2, 0.5)
    for nm, loc in (("FirePit_Flame.end_a", (0.5, 0, 0)), ("FirePit_Flame.end_b", (-0.5, 0, 0))):
        e = bpy.data.objects.new(nm, None)
        bpy.context.scene.collection.objects.link(e)
        e.parent = root
        e.location = loc
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(4, 0, 0))
    c = bpy.context.active_object
    c.name = "Cube_Other"
    c["some_prop"] = "stays"
    L.finish({"built": ["FirePit_Flame", "FirePit_Flame.end_a", "FirePit_Flame.end_b", "Cube_Other"]}, save=True)


L.run(main)
