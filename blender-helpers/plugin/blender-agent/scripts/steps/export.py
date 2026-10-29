"""export — write the game files: the mesh + the export Skeleton + its baked action.

GLB is primary (three.js); FBX is the Unity-compatible second. Exports the
"Skeleton" armature game_rig built (DEF- bones under one root, animation baked),
never the Rigify control rig.

params:
  name      file stem, default the job name
  formats   default ["glb", "fbx"]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    mesh = L.the_mesh()
    # the clean export skeleton from game_rig; the Rigify rig stays behind
    rig = bpy.data.objects.get("Skeleton")
    if rig is None:
        raise RuntimeError("no Skeleton: run game_rig before export")
    # Only the Skeleton's baked actions ship. Rigify's authoring actions ("*.rigify",
    # on the control rig) otherwise leak into the GLB as extra clips
    # (a duplicate "<clip>.rigify" entry). This step never saves, so the .blend keeps them.
    for o in L.armatures():
        if o is not rig and o.animation_data:
            o.animation_data.action = None
    dropped = [a.name for a in bpy.data.actions if a.name.endswith(".rigify")]
    for a in [a for a in bpy.data.actions if a.name.endswith(".rigify")]:
        bpy.data.actions.remove(a)
    name = L.param("name", L.ARGS["job"])
    formats = L.param("formats", ["glb", "fbx"])
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    out = {}
    if "glb" in formats:
        path = os.path.join(L.ARGS["out_dir"], f"{name}.glb")
        bpy.ops.export_scene.gltf(
            filepath=path, export_format="GLB", use_selection=True,
            export_skins=True, export_animations=True,
            export_animation_mode="ACTIONS", export_force_sampling=True,
            export_influence_nb=4, export_yup=True,
        )
        out["glb"] = path
    if "fbx" in formats:
        path = os.path.join(L.ARGS["out_dir"], f"{name}.fbx")
        # the FBX take would otherwise be named after the scene; name it after
        # the clip. This step never saves, so the rename stays out of the .blend.
        act = rig.animation_data.action if rig.animation_data else None
        if act:
            bpy.context.scene.name = act.name
        bpy.ops.export_scene.fbx(
            filepath=path, use_selection=True, object_types={"ARMATURE", "MESH"},
            add_leaf_bones=False,
            bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False,
            bake_anim_force_startend_keying=True, apply_scale_options="FBX_SCALE_ALL",
            mesh_smooth_type="FACE", path_mode="COPY", embed_textures=True,
        )
        out["fbx"] = path
    L.finish({**{k: {"file": os.path.basename(v), "bytes": os.path.getsize(v)} for k, v in out.items()},
              "actions": [a.name for a in bpy.data.actions], "dropped": dropped}, files=out)


L.run(main)
