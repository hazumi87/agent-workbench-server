"""anim_idle — a looping idle on the Rigify rig: arms lowered out of the T-pose
(FK), elbows soft, slow breathing (chest + torso bob), a little head drift.
The action is named "Idle"; first and last frames are identical so it loops.

params:
  seconds      loop length, default 4
  fps          default 30
  arm_down     degrees the arms drop from horizontal, default 70
  elbow        degrees of elbow bend, default 12
  breath       chest pitch at inhale in degrees, default 2.5
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402

AXIS_X, AXIS_Y, AXIS_Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


def rotate_about_head(pb, axis, deg):
    """Rotate a pose bone in ARMATURE space about its own head."""
    h = pb.matrix.translation.copy()
    r = Matrix.Rotation(math.radians(deg), 4, axis)
    pb.matrix = Matrix.Translation(h) @ r @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()


def main():
    rig = next(a for a in L.armatures() if a.name != "metarig")
    L.activate(rig, "POSE")
    pbs = rig.pose.bones
    fps = int(L.param("fps", 30))
    last = int(float(L.param("seconds", 4)) * fps) + 1
    down = float(L.param("arm_down", 70))
    elbow = float(L.param("elbow", 12))
    breath = float(L.param("breath", 2.5))
    H = L.dims(L.meshes())["height"]

    need = ["torso", "chest", "head"] + [f"{b}.{s}" for b in ("upper_arm_fk", "forearm_fk", "upper_arm_parent") for s in "LR"]
    missing = [n for n in need if n not in pbs]
    if missing:
        raise RuntimeError(f"rig lacks controls: {missing}")

    rig.animation_data_create()
    keyed = ["torso", "chest", "head"] + [f"{b}.{s}" for b in ("upper_arm_fk", "forearm_fk") for s in "LR"]

    def pose(frame, inhale):
        for pb in pbs:
            pb.location = (0, 0, 0)
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.rotation_euler = (0, 0, 0)
            pb.scale = (1, 1, 1)
        bpy.context.view_layer.update()
        for s, sign in (("L", 1), ("R", -1)):
            pbs[f"upper_arm_parent.{s}"]["IK_FK"] = 1.0  # FK arms
            pbs[f"upper_arm_parent.{s}"].keyframe_insert('["IK_FK"]', frame=frame)
            rotate_about_head(pbs[f"upper_arm_fk.{s}"], AXIS_Y, sign * (down - 2 * inhale))
            rotate_about_head(pbs[f"forearm_fk.{s}"], AXIS_X, -(elbow + 3 * inhale))
        rotate_about_head(pbs["chest"], AXIS_X, -breath * inhale)
        rotate_about_head(pbs["head"], AXIS_Z, 2.0 * inhale)
        torso = pbs["torso"]
        m = torso.matrix.copy()
        m.translation.z += 0.004 * H * inhale
        torso.matrix = m
        bpy.context.view_layer.update()
        for name in keyed:
            pb = pbs[name]
            pb.keyframe_insert("rotation_quaternion" if pb.rotation_mode == "QUATERNION" else "rotation_euler", frame=frame)
            pb.keyframe_insert("location", frame=frame)

    pose(1, 0.0)
    pose((last + 1) // 2, 1.0)
    pose(last, 0.0)
    act = rig.animation_data.action
    act.name = "Idle"
    act.use_fake_user = True
    scn = bpy.context.scene
    scn.render.fps = fps
    scn.frame_start, scn.frame_end = 1, last
    bpy.ops.object.mode_set(mode="OBJECT")
    L.finish({"action": act.name, "frames": [1, last], "fps": fps, "keyed": keyed}, save=True)


L.run(main)
