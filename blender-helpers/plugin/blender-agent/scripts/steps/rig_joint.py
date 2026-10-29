"""rig_joint — move one joint of the rig by name and bind again. Saves a checkpoint.

A joint is a point: moving `LeftForeArm` (the left elbow) moves that bone's head and the tail of its parent (`LeftArm`) together. The weights
are recomputed (automatic weights, same as rig_biped), the pose bones go back to rest.
params:
  joint     Mixamo bone name without prefix, e.g. "LeftForeArm" (left elbow), "LeftLeg" (left knee), "LeftUpLeg" (left hip), "Neck", "Spine1"
  move_mm   [dx, dy, dz] millimetres, world frame (+X = the character's left, +Y = backwards, +Z = up)
  mirror    true: apply the mirrored move (x negated) to the other side's joint too
  bind      false = move without re-binding (default true)
Returns the new joint positions of the moved joints and the weight statistics.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402


def other_side(n):
    return n.replace("Left", "Right") if "Left" in n else n.replace("Right", "Left") if "Right" in n else None


def main():
    arm = R.find_rig()
    joint = L.param("joint")
    mv = L.param("move_mm")
    if not joint or not (isinstance(mv, list) and len(mv) == 3):
        raise RuntimeError('give joint (a bone name such as "LeftForeArm") and move_mm [dx,dy,dz]')
    names = [joint] + ([other_side(joint)] if L.param("mirror") and other_side(joint) else [])
    for n in names:
        if R.PREFIX + n not in arm.data.bones:
            raise RuntimeError(f"no bone {n}. Bones: {', '.join(b.name.split(':', 1)[1] for b in arm.data.bones)}")
    body = bpy.data.objects[L.param("body", "body")]
    R.reset_pose(arm)
    inv = arm.matrix_world.to_3x3().inverted()
    L.activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    for i, n in enumerate(names):
        d = Vector([x / 1000 for x in mv])
        if i == 1:
            d.x = -d.x
        e = eb[R.PREFIX + n]
        e.head = e.head + inv @ d
        if e.parent is not None:
            e.parent.tail = e.head.copy()
    bpy.ops.object.mode_set(mode="OBJECT")
    weights = R.bind(body, arm) if L.param("bind", True) else None
    L.finish({"moved": names, "move_mm": mv, "joints": {n: R.joints_mm(arm)[n] for n in names}, "weights": weights}, save=True)


L.run(main)