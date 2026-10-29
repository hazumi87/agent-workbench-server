"""rig_rigify — fit Rigify's human metarig (body, arms, hands, fingers; no face
rig — mouths come from shape keys) to the one mesh, then generate the rig.

The fit is a landmark heuristic, good for a T- or A-pose biped facing -Y with
its feet at z=0 (cleanup's output):
  1. uniform scale: metarig height -> mesh height
  2. torso depth: shift everything in y to the mesh's chest centroid
  3. each arm: rotate + scale the arm chain about the shoulder joint so the
     metarig hand lands on the mesh hand (the verts furthest out in x) and the
     fingertip reach matches
  4. each leg: shift the leg chain in x/y onto the mesh's foot centroid
params:
  fingers   default true; false deletes the finger bones (mitten hands)
  generate  default true; false stops after the fitted metarig (to inspect it)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import addon_utils  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402

META_HEIGHT_BONE = "spine.006"  # its tail is the top of the head


def chain(eb, root):
    out, stack = [], [eb[root]]
    while stack:
        b = stack.pop()
        out.append(b)
        stack.extend(b.children)
    return out


def centroid(pts):
    return sum(pts, Vector()) / len(pts) if pts else None


def main():
    mesh = L.the_mesh()
    verts = [mesh.matrix_world @ v.co for v in mesh.data.vertices]
    H = max(v.z for v in verts)

    addon_utils.enable("rigify", default_set=True)
    for a in L.armatures():  # re-running on a fitted file: start clean
        bpy.data.objects.remove(a, do_unlink=True)
    L.activate(mesh)
    bpy.ops.object.armature_human_metarig_add()
    meta = bpy.context.object
    meta.name = "metarig"
    L.activate(meta, "EDIT")
    eb = meta.data.edit_bones

    # no face rig in v1
    if "face" in eb:
        for b in reversed(chain(eb, "face")):
            eb.remove(b)
    if not L.param("fingers", True):
        for side in ("L", "R"):
            for b in list(eb[f"hand.{side}"].children):
                for c in reversed(chain(eb, b.name)):
                    eb.remove(c)

    # 1. uniform scale to mesh height
    s = H / eb[META_HEIGHT_BONE].tail.z
    for b in eb:
        b.transform(Matrix.Scale(s, 4), scale=True, roll=True)

    # 2. torso depth: chest slab centroid y
    chest = [v for v in verts if 0.68 * H < v.z < 0.8 * H and abs(v.x) < 0.12 * H]
    dy = (centroid(chest).y - eb["spine.003"].head.y) if chest else 0.0
    for b in eb:
        b.transform(Matrix.Translation((0, dy, 0)))

    fit = {"height": round(H, 4), "scale": round(s, 4), "torso_dy": round(dy, 4)}
    for side, sign in (("L", 1), ("R", -1)):
        # 3. arm: pivot = shoulder joint; target = mesh hand centroid; reach = fingertip
        arm = chain(eb, f"upper_arm.{side}")
        pivot = eb[f"upper_arm.{side}"].head.copy()
        side_verts = [v for v in verts if sign * v.x > sign * pivot.x]
        reach = max(sign * v.x for v in side_verts)
        cut = sign * pivot.x + 0.8 * (reach - sign * pivot.x)
        hand_mesh = centroid([v for v in side_verts if sign * v.x > cut])
        hand_meta = centroid([b.head for b in arm if b.name.startswith(("hand", "palm"))])
        tip_meta = max((b.tail for b in arm), key=lambda p: sign * p.x)
        src, dst = hand_meta - pivot, hand_mesh - pivot
        rot = src.rotation_difference(dst).to_matrix().to_4x4()
        tip_rot = rot @ (tip_meta - pivot)
        k = (reach - sign * pivot.x) / (sign * tip_rot.x) if tip_rot.x else 1.0
        m = Matrix.Translation(pivot) @ Matrix.Scale(k, 4) @ rot @ Matrix.Translation(-pivot)
        for b in arm:
            b.transform(m, scale=True, roll=True)
        # 4. leg: shift onto the foot centroid
        leg = chain(eb, f"thigh.{side}")
        foot_mesh = centroid([v for v in verts if v.z < 0.06 * H and sign * v.x > 0])
        foot_meta = centroid([eb[f"foot.{side}"].head, eb[f"toe.{side}"].tail])
        if foot_mesh:
            d = Vector((foot_mesh.x - foot_meta.x, foot_mesh.y - foot_meta.y, 0))
            for b in leg:
                b.transform(Matrix.Translation(d))
        fit[side] = {"arm_scale": round(k, 3), "reach": round(reach, 3),
                     "hand": [round(c, 3) for c in hand_mesh], "foot": foot_mesh and [round(c, 3) for c in foot_mesh]}

    bpy.ops.object.mode_set(mode="OBJECT")
    if not L.param("generate", True):
        L.finish({"fit": fit, "generated": False, "metarig_bones": len(meta.data.bones)}, save=True)
        return

    L.activate(meta)
    bpy.ops.pose.rigify_generate()
    rig = next(a for a in L.armatures() if a is not meta)
    meta.hide_set(True)
    meta.hide_render = True
    deform = [b.name for b in rig.data.bones if b.use_deform]
    L.finish({"fit": fit, "generated": True, "rig": rig.name, "bones": len(rig.data.bones),
              "deform_bones": len(deform)}, save=True, deform=deform)


L.run(main)
