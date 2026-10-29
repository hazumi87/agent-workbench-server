"""rig_biped — rig the BARE body: a Mixamo-named biped skeleton fitted to the body, bound with automatic weights. Saves a checkpoint.

Only the object `body` is rigged. Fingers are left out on purpose: each hand moves as one piece. Other parts in the scene (a reference
`ref`, garments) are neither moved nor bound: do this before dressing, on a job that holds the reference and the body.
The skeleton is the Mixamo biped (25 bones: Hips, Spine, Spine1, Spine2, Neck, Head, HeadTop_End, shoulders, arms, forearms, hands, legs, feet,
toes) with the Mixamo bone names, so the Library's Mixamo clips apply by name with no retargeting (rig_clip).

params:
  body       object to rig (default "body")
  landmarks  optional overrides, metres: {"crotch": z, "neck": z, "ankle": z, "arm_z_L": z, "arm_z_R": z, "arm_tip": x}: use when `notes` says a landmark is doubtful
  bind       false = build the skeleton only (default true)
Returns: landmarks (what was measured), joints (head and tail of every bone, mm, with where each comes from), notes (the uncertain limbs and why),
weights (vertices, unweighted, most influences on one vertex, bones with dominant vertices), hips_scale (leg-length ratio that rig_clip scales hip motion by).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402


def main():
    body = bpy.data.objects.get(L.param("body", "body"))
    if body is None or body.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('body', 'body')}")
    if bpy.data.objects.get("rig") is not None:
        raise RuntimeError("this scene already has a rig: use rig_joint to adjust it, or kit2_restore / --from an earlier step to start over")
    V = R.world_verts(body)
    tpl = R.template()
    tw = R.template_world(tpl)
    lm = R.measure(V, L.param("landmarks"))
    fitted = R.fit(tw, V, lm)
    arm = R.build_armature(tpl, fitted)
    # hip motion of a clip is scaled by the ratio of this body's hip-to-ankle height to the template's
    k = (fitted["Hips"][0].z - fitted["LeftFoot"][0].z) / (tw["Hips"][0].z - tw["LeftFoot"][0].z)
    arm["hips_scale"] = float(k)
    arm["rest_ankle_z"] = float(fitted["LeftFoot"][0].z)
    weights = R.bind(body, arm) if L.param("bind", True) else None
    notes = list(lm["notes"])
    if weights and weights["unweighted"]:
        notes.append(f"{weights['unweighted']} vertices got no weight: they will not move with the skeleton")
    others = [o.name for o in L.meshes() if o.name not in (body.name, "ref")]
    if others:
        notes.append(f"not rigged (bare body only): {', '.join(others)}")
    joints = R.joints_mm(arm)
    for n, j in joints.items():
        j["from"] = R.HOW.get(n, "")
    lmo = {"height_mm": round(lm["H"] * 1000), "crotch_z_mm": round(lm["crotch"] * 1000), "neck_z_mm": round(lm["neck"] * 1000), "ankle_z_mm": round(lm["ankle"] * 1000),
           "arm_z_mm": {k: round(v["z"] * 1000) for k, v in lm["arm"].items()}, "arm_tip_x_mm": {k: round(v["tip"] * 1000) for k, v in lm["arm"].items()},
           "feet": {k: {"x_mm": round(v["x"] * 1000), "y_mm": [round(v["y0"] * 1000), round(v["y1"] * 1000)]} for k, v in lm["feet"].items()}, "overridden": lm["overridden"]}
    L.finish({"landmarks": lmo, "notes": notes, "joints": joints, "weights": weights, "hips_scale": round(k, 4), "bones": len(arm.data.bones),
              "fingers": "none: each hand moves as one piece"}, save=True)


L.run(main)