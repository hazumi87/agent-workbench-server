"""anim_bust — a looping idle for a bust on rig_bust's Skeleton: slow head
look-around (yaw), a little nod, breathing in the chest. The mouth's rest shape
(jawOpen default value) is left as set by mouth_keys.

params:
  seconds   loop length, default 6
  fps       default 30
  yaw       degrees each way, default 6
  pitch     degrees, default 2
  breath    chest pitch in degrees, default 1.5
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402
import _lib as L  # noqa: E402


def main():
    skel = bpy.data.objects.get("Skeleton")
    if skel is None:
        raise RuntimeError("no Skeleton: run rig_bust first")
    fps = int(L.param("fps", 30))
    last = int(float(L.param("seconds", 6)) * fps) + 1
    yaw, pitch, breath = (math.radians(float(L.param(k, d))) for k, d in (("yaw", 6), ("pitch", 2), ("breath", 1.5)))
    L.activate(skel, "POSE")
    pb = skel.pose.bones
    head, neck, chest = pb["DEF-spine.006"], pb["DEF-spine.004"], pb["DEF-spine.003"]
    for b in (head, neck, chest):
        b.rotation_mode = "QUATERNION"
    skel.animation_data_create()

    def local(b, axis, angle):
        """A rotation about an ARMATURE axis, expressed in the bone's rest frame."""
        m = b.bone.matrix_local.to_3x3()
        return (m.inverted() @ Matrix.Rotation(angle, 3, axis) @ m).to_quaternion()

    # phase in [0, 1): yaw is a full sine over the loop, breath and nod two cycles
    n = 8
    for i in range(n + 1):
        f = 1 + round(i * (last - 1) / n)
        ph = i / n
        y = yaw * math.sin(2 * math.pi * ph)
        p = pitch * math.sin(4 * math.pi * ph + 0.6)
        br = breath * (0.5 - 0.5 * math.cos(4 * math.pi * ph))
        head.rotation_quaternion = local(head, "Z", 0.7 * y) @ local(head, "X", p)
        neck.rotation_quaternion = local(neck, "Z", 0.3 * y)
        chest.rotation_quaternion = local(chest, "X", -br)
        for b in (head, neck, chest):
            b.keyframe_insert("rotation_quaternion", frame=f)
    act = skel.animation_data.action
    act.name = "Idle"
    act.use_fake_user = True
    scn = bpy.context.scene
    scn.render.fps = fps
    scn.frame_start, scn.frame_end = 1, last
    bpy.ops.object.mode_set(mode="OBJECT")
    L.finish({"action": act.name, "frames": [1, last], "fps": fps}, save=True)


L.run(main)
