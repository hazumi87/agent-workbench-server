"""strip_rig — turn a rigged stock character into what Mesh Studio delivers:
one unrigged mesh in its rest pose, no animation, no vertex groups.
Used for test inputs only.

params:
  name   name of the joined mesh (default "Character")
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    for arm in L.armatures():
        arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    for o in L.meshes():
        L.activate(o)
        for mod in list(o.modifiers):
            if mod.type == "ARMATURE":
                bpy.ops.object.modifier_apply(modifier=mod.name)
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        o.vertex_groups.clear()
        o.animation_data_clear()
    for arm in L.armatures():
        bpy.data.objects.remove(arm, do_unlink=True)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)

    ms = L.meshes()
    bpy.ops.object.select_all(action="DESELECT")
    for o in ms:
        o.select_set(True)
    bpy.context.view_layer.objects.active = ms[0]
    if len(ms) > 1:
        bpy.ops.object.join()
    mesh = L.the_mesh()
    mesh.name = L.param("name", "Character")
    L.finish({"mesh": mesh.name, "joined": len(ms), "tris": L.tris(mesh), "dims": L.dims([mesh])}, save=True)


L.run(main)
