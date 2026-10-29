"""hand_bones — add finger bones to the rig under an existing Hand bone: LeftHandThumb1-3, LeftHandIndex1-3, Middle, Ring, Pinky (15 per hand), each parented to the one before it (parent before child), the first of each finger to the Hand bone. Saves a checkpoint.

The existing 25 bones, their heads, tails, rolls and the body's weights are not touched: only new bones are added. The positions come from a hand mesh's stored joints (`hand_make` writes them on the object) or from `joints` you give. Any other hand mesh works if you give its finger joints.

params:
  armature   the rig object (default "rig")
  hand       the hand object that carries `hand_joints` (default "hand_L" / "hand_R" by `side`); not needed when `joints` is given
  side       "left" (default) or "right"
  joints     {"LeftHandIndex1": {"head_mm": [x, y, z], "tail_mm": [x, y, z], "parent": "LeftHandIndex..." | "LeftHand"}, ...}: bones to add, world mm, parent before child (names without the prefix; `rig_prefix` is added)
  rig_prefix the prefix of the bones' names (default "mixamorig:")
  palm       [x, y, z] the direction the palm faces, used to set every new bone's roll so that its local Z is the palm normal and a finger curls about its local X (default [0, 0, -1])
  tips       true: also add an end bone per finger (LeftHandIndex4, 'tip' support, 10 mm long, parented to the last segment); default false
Refuses when a bone of that name exists (the existing rig is never changed) or the Hand bone is missing.
Returns: added (name, parent, head, tail, length mm), bones_total, the order (parent-before-child check), the existing bones unchanged (heads/tails/rolls compared), notes.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402


def main():
    arm = bpy.data.objects.get(L.param("armature", "rig"))
    if arm is None or arm.type != "ARMATURE":
        raise RuntimeError("no armature (give `armature`)")
    pre = L.param("rig_prefix", "mixamorig:")
    side = L.param("side", "left")
    S = "Left" if side == "left" else "Right"
    joints = L.param("joints")
    if not joints:
        ho = bpy.data.objects.get(L.param("hand", "hand_L" if side == "left" else "hand_R"))
        if ho is None or "hand_joints" not in ho:
            raise RuntimeError("give `joints`, or a `hand` object that carries hand_joints (made by hand_make)")
        joints = json.loads(ho["hand_joints"])
        joints = {k[len(pre):] if k.startswith(pre) else k: v for k, v in joints.items()}
        joints = {k: dict(v, parent=(v["parent"][len(pre):] if v.get("parent") and v["parent"].startswith(pre) else v.get("parent"))) for k, v in joints.items()}
    joints = {k: v for k, v in joints.items() if k != f"{S}Hand"}
    if pre + f"{S}Hand" not in arm.data.bones:
        raise RuntimeError(f"the rig has no {S}Hand bone")
    # existing bones: remember them to prove nothing changed
    before = {b.name: (np.array(b.head_local), np.array(b.tail_local), np.array(b.matrix_local)) for b in arm.data.bones}
    for k in joints:
        if pre + k in arm.data.bones:
            raise RuntimeError(f"the rig already has {pre + k}: the existing rig is not changed; remove it first or give other names")
    palm = Vector(L.param("palm", [0, 0, -1])).normalized()
    inv = arm.matrix_world.inverted()
    L.activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    order, added = [], []
    # parent before child: sort by chain depth
    def depth(n):
        d = 0
        p = joints[n].get("parent")
        while p in joints:
            d += 1
            p = joints[p].get("parent")
        return d
    for n in sorted(joints, key=depth):
        j = joints[n]
        par = j.get("parent")
        if par is not None and (pre + par) not in eb:
            raise RuntimeError(f"{n}: parent {par} is not in the rig or earlier in the list")
        b = eb.new(pre + n)
        b.head = inv @ Vector([x / 1000 for x in j["head_mm"]])
        b.tail = inv @ Vector([x / 1000 for x in j["tail_mm"]])
        if (b.tail - b.head).length < 1e-6:
            raise RuntimeError(f"{n}: head and tail coincide")
        b.parent = eb[pre + par] if par else eb[pre + f"{S}Hand"]
        b.use_connect = False
        b.use_deform = True
        # roll: the bone's local Z toward the palm normal (the direction is given in the world; the bone is in the armature's local space)
        b.align_roll(inv.to_3x3() @ palm)
        order.append(n)
        added.append(n)
    if L.param("tips"):
        for n in [x for x in added if x.endswith("3")]:
            src = eb[pre + n]
            tip = eb.new(pre + n[:-1] + "4")
            d = (src.tail - src.head).normalized()
            tip.head = src.tail.copy()
            tip.tail = src.tail + d * (0.010 / max(arm.matrix_world.to_scale()[0], 1e-9))
            tip.parent = src
            tip.use_connect = False
            tip.use_deform = False
            tip.align_roll(inv.to_3x3() @ palm)
            added.append(n[:-1] + "4")
    bpy.ops.object.mode_set(mode="OBJECT")
    after = {b.name: (np.array(b.head_local), np.array(b.tail_local), np.array(b.matrix_local)) for b in arm.data.bones}
    drift = max((float(np.abs(after[k][0] - v[0]).max()) + float(np.abs(after[k][1] - v[1]).max()) + float(np.abs(after[k][2] - v[2]).max()) for k, v in before.items()), default=0.0)
    names = [b.name for b in arm.data.bones]
    pos = {n: i for i, n in enumerate(names)}
    pc_ok = all(b.parent is None or pos[b.parent.name] < pos[b.name] for b in arm.data.bones)
    sc = arm.matrix_world.to_scale()[0]
    out = [{"name": pre + n, "parent": arm.data.bones[pre + n].parent.name, "head_mm": [round(c * 1000, 2) for c in arm.matrix_world @ arm.data.bones[pre + n].head_local],
            "length_mm": round(arm.data.bones[pre + n].length * sc * 1000, 2)} for n in added]
    L.finish({"added": out, "bones_total": len(arm.data.bones), "existing_bones_changed_max": round(drift, 9), "parent_before_child": bool(pc_ok),
              "notes": ["the new bones are deform bones; the weights of the hand mesh use these names"]}, save=True)


L.run(main)
