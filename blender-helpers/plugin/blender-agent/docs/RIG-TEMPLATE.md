# Rig template (supplied locally)

The rig verbs (`rig_biped`, `rig_joint`, `rig_motion`, `rig_clip`, `export_rig`) place a biped skeleton
on a body by moving the bones of a **template** to the body's joints. Animation clips that use the same
bone names then apply to the result without retargeting. This package does **not** ship a template:
a skeleton taken from a third-party character is that party's asset data. Supply one you are entitled to use.

## Where it is read from
In order: the verb setting `rig_template` (a path), the environment variable `BLENDER_AGENT_RIG_TEMPLATE`,
then `scripts/lib/rig/template.json` (git-ignored). If none exists the verb fails with
`rig template not found: <path>` and says how to supply one; it does not guess.

## Format (JSON)
```json
{
  "about": "free text: what the template is and where it came from",
  "source_prefix": "<bone name prefix used by your clips, if any>",
  "object": {"rotation_euler": [1.570796, 0, 0], "scale": [0.01, 0.01, 0.01]},
  "bones": [
    {"name": "Hips",  "parent": null,   "head": [x, y, z], "tail": [x, y, z], "roll": 0.0},
    {"name": "Spine", "parent": "Hips", "head": [x, y, z], "tail": [x, y, z], "roll": 0.0}
  ]
}
```
- `bones[].head/tail/roll`: in the armature **object's local space**, exactly as the clip source authored them.
- `object`: the rotation (XYZ Euler, radians) and scale the armature object carries; the verbs apply it to get world metres.
- Template bone names are written WITHOUT a prefix; the verbs create the armature bones as `PREFIX + name` (`PREFIX` is "mixamorig:" in
  `scripts/steps/rig_common.py`, matching clips authored for that skeleton). The 25 names the verbs expect: Hips, Spine, Spine1, Spine2, Neck, Head,
  HeadTop_End, and for Left and Right: Shoulder, Arm, ForeArm, Hand, UpLeg, Leg, Foot, ToeBase, Toe_End. Another naming needs those names in the
  template or `PREFIX` / the names in `rig_common.py` adjusted.
- Finger bones are optional (`hand_bones`); the finger-capture mapping is `scripts/lib/rig/finger-map.json`.

## Making one
Open your rigged character in Blender, select the armature, and write its bones (in the armature's local
space, edit-bone `head`, `tail`, `roll`) with the armature object's rotation/scale into the JSON above. Check by
running a verb with `rig_template` pointing at it and viewing the result. Keep the template outside version control
unless its licence allows publishing it.
