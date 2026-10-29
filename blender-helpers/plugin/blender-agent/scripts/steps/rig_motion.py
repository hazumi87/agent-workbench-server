"""rig_motion — built-in test motions that need no clip: pose the rig, look, and measure how the skin copes. Saves nothing.

Motions (progress t from rest, 0 = T-pose, 1 = full):
  arms_up       both arms raised from the T-pose to vertical (90 degrees)
  arms_forward  both arms swung forward to point straight ahead (90 degrees)
  elbow_bend    arms forward as in arms_forward, then both forearms bent 90 degrees up (this is the one that bends the elbows)
  squat         thighs forward 60, shins back 100, feet kept flat, spine forward 15
  torso_twist   the three spine bones turned about the vertical, 20 degrees each (60 in all)
  head_turn     neck 25 and head 35 degrees about the vertical (60 in all)
For each gated joint (shoulders, elbows, hips, knees, and the spine and neck for the twist and turn) in the posed mesh against rest, over the edges
and triangles within `radius` (default 8% of the height) of the joint:
  worst_stretch_pct / worst_compression_pct  the longest / shortest edge against its rest length
  p99_stretch_pct                            the 99th percentile (one bad edge does not decide it)
  volume_loss_pct / volume_gain_pct          change of a local thickness proxy: the mean squared distance of the skin vertices around the joint to the
                                             two bones that meet there (proportional to the cross-section area): a limb that pinches or collapses at the
                                             bend loses it, one that bulges gains it
params:
  motions   list of motion names (default all six)
  frames    pictures per strip (default 4: rest, 1/3, 2/3, full)
  view      front | side | three_quarter | back (default per motion: front for arms_up/torso_twist/head_turn, side for arms_forward/squat)
  res       size of one picture px (default 384); a strip is `frames` pictures side by side: out/rig-<motion>.png
  radius_pct   region radius, percent of the height (default 8)
  gate      optional {"max_stretch_pct": x, "max_volume_loss_pct": y}: the verb FAILS (ok false) when a gated joint of a motion goes beyond them
Returns per motion: the metrics per joint, the worst of each over the joints, and gate results.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402

AX_X, AX_Y, AX_Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
# (bone, world axis, degrees at t = 1); parents come before children
MOTIONS = {
    "arms_up": {"view": "front", "ops": [("LeftArm", AX_Y, -90), ("RightArm", AX_Y, 90)], "joints": ["shoulder_L", "shoulder_R", "elbow_L", "elbow_R"]},
    "arms_forward": {"view": "side", "ops": [("LeftArm", AX_Z, -90), ("RightArm", AX_Z, 90)], "joints": ["shoulder_L", "shoulder_R", "elbow_L", "elbow_R"]},
    "elbow_bend": {"view": "side", "ops": [("LeftArm", AX_Z, -90), ("RightArm", AX_Z, 90), ("LeftForeArm", AX_X, -90), ("RightForeArm", AX_X, -90)], "joints": ["shoulder_L", "shoulder_R", "elbow_L", "elbow_R"]},
    "squat": {"view": "side", "ops": [("Spine", AX_X, -15), ("LeftUpLeg", AX_X, -60), ("RightUpLeg", AX_X, -60), ("LeftLeg", AX_X, 100), ("RightLeg", AX_X, 100),
                                         ("LeftFoot", AX_X, -40), ("RightFoot", AX_X, -40)], "joints": ["hip_L", "hip_R", "knee_L", "knee_R"]},
    "torso_twist": {"view": "front", "ops": [("Spine", AX_Z, 20), ("Spine1", AX_Z, 20), ("Spine2", AX_Z, 20)], "joints": ["spine", "shoulder_L", "shoulder_R", "hip_L", "hip_R"]},
    "head_turn": {"view": "front", "ops": [("Neck", AX_Z, 25), ("Head", AX_Z, 35)], "joints": ["neck"]},
}


def pose(arm, ops, t):
    R.reset_pose(arm)
    for bone, axis, deg in ops:
        R.rotate_world(arm, bone, axis, deg * t)


def main():
    arm = R.find_rig()
    body = bpy.data.objects[L.param("body", "body")]
    scn = bpy.context.scene
    names = L.param("motions") or list(MOTIONS)
    bad = [n for n in names if n not in MOTIONS]
    if bad:
        raise RuntimeError(f"unknown motion {bad}: {', '.join(MOTIONS)}")
    nf = int(L.param("frames", 4))
    if nf < 2:
        raise RuntimeError("frames must be at least 2")
    ad = arm.animation_data
    muted = [(t, t.mute) for t in (ad.nla_tracks if ad else [])]
    for t, _ in muted:  # clips applied earlier would overwrite the test poses at every update
        t.mute = True
    R.reset_pose(arm)
    rest = R.evaluated_verts(body)
    tris = R.tri_index(body)
    H = float(rest[:, 2].max() - rest[:, 2].min())
    regs = R.regions(rest, tris, arm, float(L.param("radius_pct", 8)) / 100 * H)
    gate = L.param("gate") or {}
    out, files, failed = {}, [], []
    for name in names:
        m = MOTIONS[name]
        pose(arm, m["ops"], 1.0)
        posed = R.evaluated_verts(body)
        met = R.joint_metrics(rest, posed, regs, arm, tris)
        sel = {k: v for k, v in met.items() if k in m["joints"]}
        worst = {"stretch_pct": max((v["worst_stretch_pct"] for v in sel.values()), default=0), "p99_stretch_pct": max((v["p99_stretch_pct"] for v in sel.values()), default=0),
                 "compression_pct": max((v["worst_compression_pct"] for v in sel.values()), default=0), "volume_loss_pct": max((v["volume_loss_pct"] for v in sel.values()), default=0)}
        fails = []
        for k, v in sel.items():
            if "max_stretch_pct" in gate and v["worst_stretch_pct"] > gate["max_stretch_pct"]:
                fails.append(f"{name}/{k}: stretch {v['worst_stretch_pct']}% > {gate['max_stretch_pct']}%")
            if "max_volume_loss_pct" in gate and v["volume_loss_pct"] > gate["max_volume_loss_pct"]:
                fails.append(f"{name}/{k}: volume loss {v['volume_loss_pct']}% > {gate['max_volume_loss_pct']}%")
        failed += fails
        view = L.param("view") or m["view"]
        path = os.path.join(L.ARGS["out_dir"], f"rig-{name}.png")
        R.strip_png(scn, body, arm, [i / (nf - 1) for i in range(nf)], path, view=view, res=int(L.param("res", 384)),
                    set_frame=lambda i, t, ops=m["ops"]: pose(arm, ops, t))
        files.append(path)
        out[name] = {"joints": sel, "worst": worst, "picture": os.path.basename(path), "view": view, "gate_failures": fails}
    R.reset_pose(arm)
    for t, was in muted:
        t.mute = was
    if failed and gate:
        L.finish({"motions": out, "gate": gate, "failed": failed}, ok=False, error="gate failed: " + "; ".join(failed), files=files)
        return
    L.finish({"motions": out, "gate": gate or None, "rendered": [os.path.basename(f) for f in files],
              "metric_note": "volume_*: mean squared distance of the skin around the joint to its two bones (proportional to the cross-section area), posed against rest"}, files=files)


L.run(main)