"""rig_clip — apply a Mixamo animation clip to the rig, look at it and measure it. Saves a checkpoint.

The clip's rotations are copied onto the rig's bones by name (the part after the colon, so `mixamorig1:Hips` and `mixamorig:Hips` both
drive `Hips`); finger and other bones the rig does not have are dropped (listed in `dropped_bones`); the hips' translation is scaled by the
rig's `hips_scale` (hip-to-ankle height of this body against the Mixamo character's), so a short-legged body does not float or sink by the
Mixamo character's leg length. The clip becomes an NLA track named `name`, so several clips can sit on one rig and all go into the export.
Applying a clip of the same `name` again replaces it.

params:
  clip    the clip file, relative to the tool root, e.g. "downloads/library/<id>.fbx" (verb.mjs fills this in and `name` when you give a Library id)
  name    the clip's name in the export (default: the file name without extension: "walking", "idle", "punch")
  frames  pictures in the strip (default 6, evenly across the clip), view (default "front"), res (default 384)
  samples poses measured across the clip (default 12)
Returns: frames and fps, bones driven / dropped, `joints` (worst stretch and volume loss at the gated joints over the sampled poses, with the frame),
`floor` (lowest point of the skin over the clip against the rest floor, mm; per foot the ankle's lowest height against its rest height),
`sliding` (per foot: while the foot is on the ground, how fast it moves sideways, mm per frame, mean and max), `travel_mm` (hips), and the strip picture.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402


def import_action(path):
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
    new = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n not in before]
    src = next((o for o in new if o.type == "ARMATURE" and o.animation_data and o.animation_data.action), None)
    if src is None:
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
        raise RuntimeError("the clip file holds no armature with an animation")
    act = src.animation_data.action
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    return act


def main():
    arm = R.find_rig()
    body = bpy.data.objects[L.param("body", "body")]
    scn = bpy.context.scene
    path = L.resolve(L.param("clip"), what="clip")
    if not os.path.isfile(path):
        raise RuntimeError(f"no such clip file: {L.param('clip')}")
    name = str(L.param("name") or os.path.splitext(os.path.basename(path))[0])
    act = import_action(path)
    old = bpy.data.actions.get(name)
    if old is not None and old is not act:
        bpy.data.actions.remove(old)
    act.name = name
    k = float(arm.get("hips_scale", 1.0))
    have = {b.name.split(":", 1)[1] for b in arm.data.bones}
    driven, dropped = set(), set()
    for fc in list(act.fcurves):
        dp = fc.data_path
        if not dp.startswith('pose.bones["'):
            act.fcurves.remove(fc)
            continue
        bone = dp.split('"')[1]
        short = bone.split(":", 1)[-1]
        if short not in have:
            dropped.add(short)
            act.fcurves.remove(fc)
            continue
        fc.data_path = dp.replace(f'"{bone}"', f'"{R.PREFIX}{short}"', 1)
        driven.add(short)
        if short == "Hips" and dp.endswith(".location"):
            for kp in fc.keyframe_points:
                kp.co[1] *= k
                kp.handle_left[1] *= k
                kp.handle_right[1] *= k
            fc.update()
    f0, f1 = (int(round(x)) for x in act.frame_range)
    if arm.animation_data is None:
        arm.animation_data_create()
    ad = arm.animation_data
    for tr in [t for t in ad.nla_tracks if t.name == name]:
        ad.nla_tracks.remove(tr)
    act.use_fake_user = True
    track = ad.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, f0, act)
    strip.action_frame_start, strip.action_frame_end = f0, f1
    for t in ad.nla_tracks:
        t.mute = t.name != name  # only this clip drives the rig while it is measured
    ad.action = None
    scn.render.fps = 30
    scn.frame_start, scn.frame_end = f0, f1
    R.reset_pose(arm)
    # the rest mesh: no track drives the bones
    for t in ad.nla_tracks:
        t.mute = True
    bpy.context.view_layer.update()
    R.reset_pose(arm)
    rest = R.evaluated_verts(body)
    for t in ad.nla_tracks:
        t.mute = t.name != name
    tris = R.tri_index(body)
    H = float(rest[:, 2].max() - rest[:, 2].min())
    zmin = float(rest[:, 2].min())
    regs = R.regions(rest, tris, arm, 0.08 * H)
    ns = int(L.param("samples", 12))
    sample_frames = sorted({int(round(x)) for x in np.linspace(f0, f1, ns)})
    worst = {}
    low_skin, low_at = 1e9, f0
    for f in sample_frames:
        scn.frame_set(f)
        posed = R.evaluated_verts(body)
        met = R.joint_metrics(rest, posed, regs, arm, tris)
        for key, v in met.items():
            w = worst.setdefault(key, {"worst_stretch_pct": -1, "volume_loss_pct": -1, "frame_stretch": f, "frame_volume": f, "worst_compression_pct": 0})
            if v["worst_stretch_pct"] > w["worst_stretch_pct"]:
                w["worst_stretch_pct"], w["frame_stretch"] = v["worst_stretch_pct"], f
            if v["volume_loss_pct"] > w["volume_loss_pct"]:
                w["volume_loss_pct"], w["frame_volume"] = v["volume_loss_pct"], f
            w["worst_compression_pct"] = max(w["worst_compression_pct"], v["worst_compression_pct"])
        z = float(posed[:, 2].min())
        if z < low_skin:
            low_skin, low_at = z, f
    # feet over every frame
    mw = arm.matrix_world
    track_xyz = {"LeftFoot": [], "RightFoot": [], "Hips": []}
    for f in range(f0, f1 + 1):
        scn.frame_set(f)
        bpy.context.view_layer.update()
        for b in track_xyz:
            track_xyz[b].append(np.array(mw @ arm.pose.bones[R.PREFIX + b].head))
    rest_ankle = float(arm.get("rest_ankle_z", 0.0))
    floor = {"lowest_skin_vs_rest_floor_mm": round((low_skin - zmin) * 1000, 1), "at_frame": low_at}
    sliding = {}
    for b in ("LeftFoot", "RightFoot"):
        P = np.array(track_xyz[b])
        floor[f"{b}_lowest_ankle_vs_rest_mm"] = round((P[:, 2].min() - rest_ankle) * 1000, 1)
        on = np.nonzero(P[:, 2] <= P[:, 2].min() + 0.015)[0]
        onset = set(int(j) for j in on)
        sp = [float(np.linalg.norm(P[j + 1, :2] - P[j, :2])) * 1000 for j in sorted(onset) if j + 1 in onset]
        sliding[b] = {"contact_frames": int(len(on)), "mean_mm_per_frame": round(float(np.mean(sp)), 1) if sp else None, "max_mm_per_frame": round(float(np.max(sp)), 1) if sp else None}
    Hh = np.array(track_xyz["Hips"])
    travel = [round(float(x) * 1000) for x in (Hh.max(0) - Hh.min(0))]
    nf = int(L.param("frames", 6))
    pics = [int(round(x)) for x in np.linspace(f0, f1, nf)]
    out_png = os.path.join(L.ARGS["out_dir"], f"rig-clip-{name.replace(' ', '_')}.png")
    R.strip_png(scn, body, arm, pics, out_png, view=L.param("view", "front"), res=int(L.param("res", 384)), set_frame=lambda i, f: scn.frame_set(f))
    for t in ad.nla_tracks:
        t.mute = False
    scn.frame_set(f0)
    L.finish({"clip": name, "file": L.param("clip"), "frames": [f0, f1], "fps": 30, "driven_bones": len(driven), "dropped_bones": sorted(dropped), "hips_scale": round(k, 4),
              "joints": worst, "floor": floor, "sliding": sliding, "hips_travel_mm_xyz": travel, "rendered": [os.path.basename(out_png)],
              "clips_on_rig": [t.name for t in ad.nla_tracks]}, save=True, files=[out_png])


L.run(main)