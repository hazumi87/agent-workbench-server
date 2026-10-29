"""rig_joints — set SEVERAL joints at once by absolute position (or move them), roll bones, and leave the binding alone (or bind at the end). Saves a checkpoint.

A joint is a point: setting `LeftLeg` (the left knee) sets that bone's head and its parent's tail together. Where a parent has several children (Hips: Spine, LeftUpLeg, RightUpLeg; Spine2: Neck, LeftShoulder, RightShoulder) its tail follows only its centre-line child (Spine, Neck):
setting a side joint (LeftUpLeg) moves that bone's head and leaves the parent's tail where it is; `branches` in the report names each such parent and the side joints set. By default nothing is re-bound: the weights stay as they are while the skeleton is placed, so one
batch edit of many joints costs one bind (rig_bind) instead of one each. (A mesh bound before the edit keeps its shape: it is the pose that moves it, and the pose is reset to rest.)

params:
  joints   {"LeftLeg": [x, y, z], ...} Mixamo bone names without the prefix; positions in millimetres, world frame (+X = the character's left, +Y = backwards, +Z = up)
  mode     "absolute" (default: the head ends at that position) or "relative" (the head moves by that many mm)
  mirror   true: for every joint given on one side and not on the other, set the other side's joint at the mirrored position (x negated)
  tails    {"LeftToe_End": [x, y, z], ...}: set a bone's TAIL at that world position (mm) after all heads are placed (mirror: true mirrors tails given on one side too). A bone that has connected children is refused (set the child's head instead).
  leaf_tails  "offset" (default): a bone with no children (Toe_End, HeadTop_End, Hand...) whose head is set keeps its own head-to-tail offset, so its tail moves with the head; "keep": the tail stays where it was
  rolls    {"LeftLeg": degrees, ...}: set a bone's roll (the bend axis of a hinge) absolutely
  bind     false (default): do not bind; true: bind at the end with automatic weights
  body     the mesh (default "body")
Returns: moved (each joint: before, after, move_mm), tails_set, branches (parents with several children: which child their tail follows, and which side joints were set without moving it), bones (length before/after of every bone whose length changed), rolls, symmetry (left/right height and width differences of the main joints), weights when bound.
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
    given = L.param("joints") or {}
    rolls = L.param("rolls") or {}
    if not isinstance(given, dict) or (not given and not rolls):
        raise RuntimeError('give joints {"LeftLeg": [x, y, z], ...} (mm) and/or rolls {"LeftLeg": degrees}')
    mode = L.param("mode", "absolute")
    if mode not in ("absolute", "relative"):
        raise RuntimeError('mode must be "absolute" or "relative"')
    targets = {}
    for n, p in given.items():
        if R.PREFIX + n not in arm.data.bones:
            raise RuntimeError(f"no bone {n}. Bones: {', '.join(b.name.split(':', 1)[1] for b in arm.data.bones)}")
        if not (isinstance(p, list) and len(p) == 3):
            raise RuntimeError(f"{n}: give [x, y, z] in millimetres")
        targets[n] = [float(x) for x in p]
    tails_given = {}
    for n, p in (L.param("tails") or {}).items():
        if R.PREFIX + n not in arm.data.bones:
            raise RuntimeError(f"tails: no bone {n}")
        if not (isinstance(p, list) and len(p) == 3):
            raise RuntimeError(f"tails {n}: give [x, y, z] in millimetres")
        tails_given[n] = [float(x) for x in p]
    leaf_mode = L.param("leaf_tails", "offset")
    if leaf_mode not in ("offset", "keep"):
        raise RuntimeError('leaf_tails must be "offset" or "keep"')
    if L.param("mirror"):
        for n, p in list(targets.items()):
            o = other_side(n)
            if o and o not in targets:
                targets[o] = [-p[0], p[1], p[2]]
        for n, p in list(tails_given.items()):
            o = other_side(n)
            if o and o not in tails_given:
                tails_given[o] = [-p[0], p[1], p[2]]
    R.reset_pose(arm)
    before = R.joints_mm(arm)
    inv = arm.matrix_world.inverted()
    L.activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    lengths0 = {b.name: b.length for b in eb}
    moved, branches = {}, {}
    for n, p in targets.items():
        e = eb[R.PREFIX + n]
        cur = arm.matrix_world @ e.head
        want = Vector([x / 1000 for x in p]) if mode == "absolute" else cur + Vector([x / 1000 for x in p])
        offset = e.tail - e.head
        e.head = inv @ want
        if not e.children and leaf_mode == "offset" and n not in tails_given:
            e.tail = e.head + offset  # a leaf bone: its tail goes with its head
        if e.parent is not None:
            sibs = list(e.parent.children)
            main = next((c for c in sibs if not c.name[len(R.PREFIX):].startswith(("Left", "Right"))), None) if len(sibs) > 1 else e
            if main is not None and e.name == main.name:  # (EditBone wrappers are new objects each time: compare names, not identity)
                e.parent.tail = e.head.copy()  # a parent with one child, or its main (centre-line) child: the tail follows the joint
            else:
                branches.setdefault(e.parent.name[len(R.PREFIX):], {"children": [c.name[len(R.PREFIX):] for c in sibs], "tail_follows": main.name[len(R.PREFIX):] if main else None, "branch_joints_set": []})["branch_joints_set"].append(n)
        moved[n] = {"before_mm": [round(x * 1000, 1) for x in cur], "after_mm": [round(x * 1000, 1) for x in want], "move_mm": [round((w - c) * 1000, 1) for w, c in zip(want, cur)]}
    tails_set = {}
    for n, p in tails_given.items():
        e = eb[R.PREFIX + n]
        if any(c.use_connect for c in e.children):
            raise RuntimeError(f"tails {n}: it has connected children; set the child's head instead")
        before_t = arm.matrix_world @ e.tail
        e.tail = inv @ Vector([x / 1000 for x in p])
        tails_set[n] = {"before_mm": [round(x * 1000, 1) for x in before_t], "after_mm": [round(x, 1) for x in p]}
    done_rolls = {}
    for n, deg in rolls.items():
        if R.PREFIX + n not in eb:
            raise RuntimeError(f"no bone {n} for roll")
        import math
        eb[R.PREFIX + n].roll = math.radians(float(deg))
        done_rolls[n] = float(deg)
    chg = {b.name.split(":", 1)[1]: {"before_mm": round(lengths0[b.name] * 1000 * arm.matrix_world.to_scale()[0], 1), "after_mm": round(b.length * 1000 * arm.matrix_world.to_scale()[0], 1)}
           for b in eb if abs(b.length - lengths0[b.name]) > 1e-9}
    bpy.ops.object.mode_set(mode="OBJECT")
    after = R.joints_mm(arm)
    sym = {}
    for n in ("UpLeg", "Leg", "Foot", "Arm", "ForeArm", "Hand"):
        l, r = after.get("Left" + n), after.get("Right" + n)
        if l and r:
            sym[n] = {"height_diff_mm": round(l["head_mm"][2] - r["head_mm"][2], 1), "width_sum_mm": round(l["head_mm"][0] + r["head_mm"][0], 1)}
    out = {"mode": mode, "moved": moved, "branches": branches, "tails_set": tails_set, "bones": chg, "rolls": done_rolls, "symmetry": sym}
    if L.param("bind", False):
        body = bpy.data.objects[L.param("body", "body")]
        out["weights"] = R.bind(body, arm)
    L.finish(out, save=True)


L.run(main)
