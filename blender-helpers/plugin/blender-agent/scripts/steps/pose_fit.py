"""pose_fit — pose the rig to match the captured joints of the reference at one instant, and make a static POSED COPY of the body in the reference's coordinates. Saves a checkpoint.

For projecting the video frames onto the character: the photo shows the person posed, so the mesh must be posed the same way. The fit is rotation only: each bone is swung (parents first) so that it points where the captured
joint chain points (bone lengths are the character's own; nothing is stretched), the hips are placed and turned to the captured pelvis (up from the pelvis to the upper spine, side from the two hips), and the character is scaled ONCE for the whole sequence
(its height over the median captured height, 1.699 m, or `scale`), never per frame. Twist about a bone's own axis is not fitted. Fingers and toes are not fitted.
The rig is left posed in the checkpoint (reset_pose or any rig verb puts it back to rest). The copy `body_posed` is a plain mesh in the reference's coordinates and metres (same UV layers and materials as the body) hidden from
the render; `photo_project` projects onto it.

params:
  bundle   the bundle folder or zip (see reference_import) (required: reads reference.json and capture-motion.npz)
  time_s   the captured instant (seconds, default 0.5): the nearest of the 1,822 presentation instants
  kind     "smooth" (default) or "observed" (refuses an instant that was not observed)
  scale    uniform scale from the character to the reference (default: the body's height / 1.699 m)
  body     the mesh (default "body"); the rig is `rig`
  fingers  true: also swing every finger bone present in the rig (hand_bones adds them) to the CAPTURED direction of its source joint pair, from scripts/lib/rig/finger-map.json (positions only: no twist; the capture's finger joints are model estimates, not validated finger capture); the fit report lists each bone's turn and remaining direction error
  copy     name of the posed copy (default "body_posed"; replaced when it exists)
Returns: torso_axis (the Hips to Neck vector as fitted and as captured, in reference mm: vector, length, unit, tilt from straight up, lean back / lean left; the angle between the two; the character's own rest axis), joints_mm (every fitted joint: fitted position, captured position, error, reference mm, pelvis origin, +X left, +Y back, +Z up), instant (time, frame, inferred, observed_valid), scale, fit (per bone: angle turned, direction error after in degrees), joint_error_mm (mean / worst, in reference mm, over the fitted joints after posing), floor_gap_mm (the copy's lowest point above the floor), posed_copy.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import json  # noqa: E402
import _lib as L  # noqa: E402
import _bundle as B  # noqa: E402
import rig_common as R  # noqa: E402

PRE = R.PREFIX
# bone -> the bone whose HEAD is its target tail (swing the bone toward it)
AIM = {"Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head", "Head": "HeadTop_End", "LeftShoulder": "LeftArm", "LeftArm": "LeftForeArm", "LeftForeArm": "LeftHand",
       "RightShoulder": "RightArm", "RightArm": "RightForeArm", "RightForeArm": "RightHand", "LeftUpLeg": "LeftLeg", "LeftLeg": "LeftFoot", "LeftFoot": "LeftToeBase",
       "RightUpLeg": "RightLeg", "RightLeg": "RightFoot", "RightFoot": "RightToeBase"}
ORDER = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "RightShoulder", "RightArm", "RightForeArm", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot"]


def frame(up, side):
    up = up / np.linalg.norm(up)
    s = side - up * (side @ up)
    s = s / np.linalg.norm(s)
    return np.stack([s, up, np.cross(s, up)], 1)  # columns: side, up, forward


def rot_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else Matrix.Rotation(np.pi, 3, Vector(np.cross(a, [1, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1, 0]))).to_3x3()
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k * (1 / (1 + c))


def swing(arm, bone, Rm):
    pb = arm.pose.bones[PRE + bone]
    bpy.context.view_layer.update()
    mw = arm.matrix_world
    head = mw @ pb.head
    M = Matrix(Rm.tolist()).to_4x4()
    piv = Matrix.Translation(head) @ M @ Matrix.Translation(-head)
    pb.matrix = mw.inverted() @ piv @ (mw @ pb.matrix)
    bpy.context.view_layer.update()


def head_of(arm, b):
    return np.array(arm.matrix_world @ arm.pose.bones[PRE + b].head)


def main():
    arm = R.find_rig()
    body = bpy.data.objects[L.param("body", "body")]
    b = L.param("bundle")
    if not b:
        raise RuntimeError("bundle is required")
    d = B.bundle(b)
    ref = json.loads((d / "reference.json").read_text())
    z = np.load(d / "capture-motion.npz", allow_pickle=False)
    t = float(L.param("time_s", 0.5))
    times = z["times_s"]
    k = int(np.argmin(np.abs(times - t)))
    kind = L.param("kind", "smooth")
    if kind not in ("smooth", "observed"):
        raise RuntimeError('kind must be "smooth" or "observed"')
    inferred, valid = bool(z["inferred"][k]), bool(z["observed_valid"][k])
    if kind == "observed" and not valid:
        raise RuntimeError(f"no observed capture at {float(times[k]):.3f} s")
    J = np.array(z[f"joints_{kind}"][k], float)
    mx = ref["mixamo_source_indices"]
    R.reset_pose(arm)
    V0 = R.evaluated_verts(body)
    H = float(V0[:, 2].max() - V0[:, 2].min())
    s = float(L.param("scale")) if L.param("scale") is not None else H / 1.699
    T = {n: s * J[i] for n, i in mx.items()}  # the captured joints in the character's metres, pelvis at the origin on the floor
    # place the rig's pelvis: hips head to the captured pelvis (the rest hips are at their own height: keep the rest x/y centre)
    rest = {n: head_of(arm, n) for n in mx if PRE + n in arm.data.bones}
    # hips orientation: up from the spine, side from the two hips
    # the torso axis (pelvis to the upper spine: the captured Spine joint sits just in front of the pelvis and says nothing about "up")
    f_rest = frame(rest["Spine2"] - rest["Hips"], rest["LeftUpLeg"] - rest["RightUpLeg"])
    f_tgt = frame(T["Spine2"] - T["Hips"], T["LeftUpLeg"] - T["RightUpLeg"])
    swing(arm, "Hips", f_tgt @ f_rest.T)
    pb = arm.pose.bones[PRE + "Hips"]
    want = Vector(T["Hips"])
    cur = arm.matrix_world @ pb.head
    mw = arm.matrix_world
    pb.matrix = mw.inverted() @ Matrix.Translation(want - cur) @ mw @ pb.matrix
    bpy.context.view_layer.update()
    fit = {}
    for bn in ORDER[1:]:
        tail_b = AIM[bn]
        cur_d = head_of(arm, tail_b) - head_of(arm, bn)  # the rig's own chain direction (rest bone to the next bone's head)
        tgt_d = T[tail_b] - T[bn]
        a = np.degrees(np.arccos(np.clip((cur_d @ tgt_d) / (np.linalg.norm(cur_d) * np.linalg.norm(tgt_d)), -1, 1)))
        swing(arm, bn, rot_between(cur_d, tgt_d))
        nd = head_of(arm, tail_b) - head_of(arm, bn)
        err = np.degrees(np.arccos(np.clip((nd @ tgt_d) / (np.linalg.norm(nd) * np.linalg.norm(tgt_d)), -1, 1)))
        fit[bn] = {"turned_deg": round(float(a), 1), "direction_error_deg": round(float(err), 2)}
    # ---- the fingers (optional): each finger bone swung to the captured direction of its source joint pair (scripts/lib/rig/finger-map.json), parents first
    fingers_report = None
    if L.param("fingers"):
        fm = json.loads(open(L.resolve("scripts/lib/rig/finger-map.json"), encoding="utf-8").read())
        fingers_report = {}
        for row in fm["rows"]:  # the file lists each finger's segments in order (1, 2, 3), so a parent comes before its child
            bn = row["target"]
            if PRE + bn not in arm.data.bones:
                continue
            pb = arm.pose.bones[PRE + bn]
            bpy.context.view_layer.update()
            cur = np.array(arm.matrix_world @ pb.tail) - np.array(arm.matrix_world @ pb.head)
            tgt = s * (J[row["tail"]] - J[row["head"]])
            if np.linalg.norm(cur) < 1e-9 or np.linalg.norm(tgt) < 1e-9:
                continue
            a = np.degrees(np.arccos(np.clip((cur @ tgt) / (np.linalg.norm(cur) * np.linalg.norm(tgt)), -1, 1)))
            swing(arm, bn, rot_between(cur, tgt))
            nd = np.array(arm.matrix_world @ pb.tail) - np.array(arm.matrix_world @ pb.head)
            err = np.degrees(np.arccos(np.clip((nd @ tgt) / (np.linalg.norm(nd) * np.linalg.norm(tgt)), -1, 1)))
            fingers_report[bn] = {"turned_deg": round(float(a), 1), "direction_error_deg": round(float(err), 2)}
    posed = R.evaluated_verts(body)
    errs = []
    for n in T:
        if PRE + n in arm.data.bones and n in AIM or n == "Hips":
            errs.append(np.linalg.norm(head_of(arm, n) - T[n]) / s * 1000)
    # the torso axis and the joint coordinates: where the fit put each joint and where the capture has it (reference mm, pelvis origin, +X left, +Y back, +Z up)
    fitted = {n: head_of(arm, n) / s * 1000 for n in T if PRE + n in arm.data.bones}
    source = {n: np.array(J[i]) * 1000 for n, i in mx.items() if n in fitted}

    def ang(a, c):
        return float(np.degrees(np.arccos(np.clip((a @ c) / (np.linalg.norm(a) * np.linalg.norm(c)), -1, 1))))

    def axis_of(P):
        v = P["Neck"] - P["Hips"]
        u = v / np.linalg.norm(v)
        lean_back = float(np.degrees(np.arctan2(u[1], u[2])))  # + = the neck is behind the hips, - = in front (the side view)
        lean_left = float(np.degrees(np.arctan2(u[0], u[2])))
        return {"vector_mm": [round(float(x), 1) for x in v], "length_mm": round(float(np.linalg.norm(v)), 1), "unit": [round(float(x), 4) for x in u], "tilt_from_up_deg": round(ang(v, np.array([0, 0, 1.0])), 2),
                "lean_back_deg": round(lean_back, 2), "lean_left_deg": round(lean_left, 2)}
    torso = None
    if "Neck" in fitted and "Hips" in fitted:
        fa, sa = axis_of(fitted), axis_of(source)
        rv = (rest["Neck"] - rest["Hips"])
        torso = {"fitted": fa, "source": sa, "angle_between_deg": round(ang(np.array(fa["vector_mm"]), np.array(sa["vector_mm"])), 2),
                 "rest_character": {"vector_mm": [round(float(x) * 1000, 1) for x in rv], "tilt_from_up_deg": round(ang(rv, np.array([0, 0, 1.0])), 2)}}
    joints_mm = {n: {"fitted": [round(float(x), 1) for x in fitted[n]], "source": [round(float(x), 1) for x in source[n]], "error_mm": round(float(np.linalg.norm(fitted[n] - source[n])), 1)} for n in fitted}
    # the posed copy in the reference's coordinates (metres)
    Vp = posed / s
    cname = L.param("copy", "body_posed")
    old = bpy.data.objects.get(cname)
    if old is not None:
        bpy.data.objects.remove(old)
    if bpy.data.meshes.get(cname) is not None:
        bpy.data.meshes.remove(bpy.data.meshes[cname])
    me = body.data.copy()
    me.name = cname
    co = np.ascontiguousarray(Vp, dtype=np.float64).ravel()
    for md in []:
        pass
    me.vertices.foreach_set("co", co)
    me.update()
    ob = bpy.data.objects.new(cname, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.hide_render = True
    ob.hide_viewport = False
    ob["reference_time_s"] = float(times[k])
    ob["scale_to_reference"] = s
    L.finish({"instant": {"time_s": round(float(times[k]), 4), "frame": k, "inferred": inferred, "observed_valid": valid, "kind": kind}, "scale": round(s, 4), "fit": fit,
              "fingers": fingers_report, "joint_error_mm": {"mean": round(float(np.mean(errs)), 1), "worst": round(float(np.max(errs)), 1)}, "floor_gap_mm": round(float(Vp[:, 2].min() * 1000), 1), "torso_axis": torso, "joints_mm": joints_mm, "posed_copy": ob.name,
              "copy_height_m": round(float(Vp[:, 2].max() - Vp[:, 2].min()), 3), "rig_left_posed": True}, save=True)


L.run(main)
