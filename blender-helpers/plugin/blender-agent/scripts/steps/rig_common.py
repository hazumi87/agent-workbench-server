"""rig_common — shared code of the rig verbs (rig_biped, rig_joint, rig_motion, rig_clip, export_rig). Not a verb.

The rig is a biped template with the bones moved to fit THIS body, so clips authored for the same bone names apply without retargeting.
The template is NOT shipped: supply your own (setting `rig_template`, env BLENDER_AGENT_RIG_TEMPLATE, or scripts/lib/rig/template.json; format
and setup in docs/RIG-TEMPLATE.md). Bone head/tail/roll are stored in the armature object's local space exactly as the clip source authored
them (the object may carry a rotation and scale): a clip's rotations are relative to that rest orientation, so the roll is kept and only the
head and tail are moved to the body's joints.
"""
import json
import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

import _lib as L

PREFIX = "mixamorig:"
LIMB_JOINTS = {  # the joints the motion tests are gated on: region centre = the head of this bone
    "shoulder_L": "LeftArm", "shoulder_R": "RightArm", "elbow_L": "LeftForeArm", "elbow_R": "RightForeArm",
    "hip_L": "LeftUpLeg", "hip_R": "RightUpLeg", "knee_L": "LeftLeg", "knee_R": "RightLeg",
    "spine": "Spine1", "neck": "Neck",
}


TEMPLATE_ENV = "BLENDER_AGENT_RIG_TEMPLATE"
DEFAULT_TEMPLATE = "scripts/lib/rig/template.json"


def template_path():
    p = L.param("rig_template") or os.environ.get(TEMPLATE_ENV) or DEFAULT_TEMPLATE
    return L.resolve(str(p))


def template():
    """The locally supplied rig template, or a clear error saying what is missing and where to put it."""
    path = template_path()
    if not os.path.isfile(path):
        raise RuntimeError(
            f"rig template not found: {path}. This tool does not ship a rig template. Supply one (see docs/RIG-TEMPLATE.md) and point to it with "
            f"the setting `rig_template`, the environment variable {TEMPLATE_ENV}, or the file {DEFAULT_TEMPLATE}.")
    with open(path, encoding="utf-8") as f:
        tpl = json.load(f)
    missing = [k for k in ("object", "bones") if k not in tpl]
    if missing:
        raise RuntimeError(f"rig template {path} is missing {missing} (see docs/RIG-TEMPLATE.md)")
    return tpl


def object_matrix(tpl):
    r, s = tpl["object"]["rotation_euler"], tpl["object"]["scale"]
    return Matrix.LocRotScale(None, __import__("mathutils").Euler(r, "XYZ"), Vector(s))


def template_world(tpl):
    """Template bone head/tail positions in world metres: {bone: (head, tail)}."""
    m = object_matrix(tpl)
    return {b["name"]: (m @ Vector(b["head"]), m @ Vector(b["tail"])) for b in tpl["bones"]}


def world_verts(o):
    n = len(o.data.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    o.data.vertices.foreach_get("co", co)
    m = np.array(o.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


# ---------------------------------------------------------------- measuring the body
def measure(V, override=None):
    """landmarks of a T-pose body (faces -Y, left = +X, standing on its lowest point). Also the doubts: `notes` lists what is uncertain."""
    ov = override or {}
    zmin, zmax = float(V[:, 2].min()), float(V[:, 2].max())
    H = zmax - zmin
    xmax = float(V[:, 0].max())
    notes = []
    lm = {"zmin": zmin, "zmax": zmax, "H": H, "xmax": xmax}
    arm = {}
    for nm, sg in (("L", 1), ("R", -1)):
        s = V[V[:, 0] * sg > 0.55 * xmax]
        if len(s) < 50:
            notes.append(f"arm_{nm}: only {len(s)} vertices beyond 55% of the arm span: arm joints are from the template proportions")
            s = V[V[:, 0] * sg > 0.3 * xmax]
        arm[nm] = {"z": float(np.median(s[:, 2])), "y": float(np.median(s[:, 1])), "z_spread": float(s[:, 2].std()), "tip": float(np.abs(s[:, 0]).max())}
        if arm[nm]["z_spread"] > 0.06 * H:
            notes.append(f"arm_{nm}: the outer arm's height varies by {arm[nm]['z_spread'] * 1000:.0f} mm (1 sigma): is it level (T-pose)? the arm axis is taken as the median height")
    if abs(arm["L"]["z"] - arm["R"]["z"]) > 0.03 * H:
        notes.append(f"arms are at different heights: left {arm['L']['z'] * 1000:.0f} mm, right {arm['R']['z'] * 1000:.0f} mm")
    lm["arm"] = arm
    if abs(arm["L"]["y"] - arm["R"]["y"]) > 0.05 * H:
        notes.append(f"the arms are not on one front-back line: left {arm['L']['y'] * 1000:.0f} mm, right {arm['R']['y'] * 1000:.0f} mm (each arm bone follows its own arm)")
    mid = V[np.abs(V[:, 0]) < 0.02 * H]
    lm["crotch"] = float(mid[:, 2].min()) if len(mid) else zmin + 0.4 * H
    if not len(mid):
        notes.append("no body vertices on the centre line: the crotch height is a guess (40% of the height)")
    zs = np.linspace(zmin + 0.62 * H, zmin + 0.92 * H, 40)
    wid = []
    for z in zs:
        s = V[(np.abs(V[:, 2] - z) < 0.01 * H) & (np.abs(V[:, 0]) < 0.18 * H)]
        wid.append(float(s[:, 0].max() - s[:, 0].min()) if len(s) > 20 else float("inf"))
    wid = np.array(wid)
    lm["neck"] = float(zs[int(np.argmin(wid))])
    fin = wid[np.isfinite(wid)]
    if len(fin) and fin.min() > 0.85 * np.median(fin):
        notes.append("neck: the torso column has no clear narrowing between 62% and 92% of the height: the neck height is a guess")
    band = V[V[:, 2] < zmin + 0.12 * H]
    feet = {}
    for nm, sg in (("L", 1), ("R", -1)):
        p = band[band[:, 0] * sg > 0.01 * H]
        if len(p) < 50:
            raise RuntimeError(f"cannot find the {nm} foot: fewer than 50 body vertices in the lowest 12% of the height")
        lo, hi = np.percentile(p, 2, axis=0), np.percentile(p, 98, axis=0)
        feet[nm] = {"x": float((lo[0] + hi[0]) / 2), "y0": float(lo[1]), "y1": float(hi[1]), "w": float(hi[0] - lo[0])}
    lm["feet"] = feet
    # ankle: the narrowest leg slice between the sole and 22% of the height
    az = []
    zs2 = np.linspace(zmin + 0.03 * H, zmin + 0.22 * H, 30)
    for z in zs2:
        w_ = []
        for nm, sg in (("L", 1), ("R", -1)):
            s = V[(np.abs(V[:, 2] - z) < 0.008 * H) & (V[:, 0] * sg > 0.01 * H) & (np.abs(V[:, 0] - sg * abs(feet[nm]["x"])) < 0.12 * H)]
            w_.append(float(s[:, 0].max() - s[:, 0].min()) if len(s) > 15 else float("inf"))
        az.append(max(w_))
    az = np.array(az)
    lm["ankle"] = float(np.clip(zs2[int(np.argmin(az))], zmin + 0.04 * H, zmin + 0.15 * H)) if np.isfinite(az).any() else zmin + 0.07 * H
    lm["notes"] = notes
    for k, v in ov.items():  # the operator's own numbers win
        if k in ("crotch", "neck", "ankle"):
            lm[k] = float(v)
        elif k in ("arm_z_L", "arm_z_R"):
            lm["arm"][k[-1]]["z"] = float(v)
        elif k == "arm_tip":
            for nm in ("L", "R"):
                lm["arm"][nm]["tip"] = float(v)
    lm["overridden"] = sorted(ov)
    return lm


def slice_y(V, H, z, half=0.18):
    s = V[(np.abs(V[:, 2] - z) < 0.02 * H) & (np.abs(V[:, 0]) < half * H)]
    return float((np.percentile(s[:, 1], 5) + np.percentile(s[:, 1], 95)) / 2) if len(s) > 20 else 0.0  # the middle of the slice front to back


# ---------------------------------------------------------------- fitting the template to the body
def fit(tw, V, lm):
    """{bone: (head, tail)} in world metres, the Mixamo template moved to this body. `how` says where each joint comes from."""
    H, zmin = lm["H"], lm["zmin"]
    hips_z = tw["Hips"][0].z
    dz = [0.0, tw["LeftUpLeg"][0].z, tw["Neck"][0].z, tw["HeadTop_End"][1].z]
    oz = [zmin, lm["crotch"], lm["neck"], lm["zmax"]]
    # the foot and ankle: the template's ankle height maps to the measured ankle, not to a proportion of the leg
    dz = [0.0, tw["LeftFoot"][0].z] + dz[1:]
    oz = [zmin, lm["ankle"]] + oz[1:]
    mz = lambda z: float(np.interp(z, dz, oz))  # noqa: E731
    shx_d = tw["LeftShoulder"][1].x
    tip_d = tw["LeftHand"][1].x
    root_d = tw["LeftShoulder"][0].x
    out = {}
    for name, (h, t) in tw.items():
        pts = []
        for p in (h, t):
            if any(k in name for k in ("Arm", "Shoulder", "Hand")):
                sg = 1 if p.x >= 0 else -1
                a = lm["arm"]["L" if sg > 0 else "R"]
                x = sg * float(np.interp(abs(p.x), [root_d, shx_d, tip_d], [0.06 * lm["xmax"], 0.2 * lm["xmax"], a["tip"]]))
                z = a["z"]
                y = a["y"] + (p.y - tw["LeftArm"][0].y) * H / 1.98
            elif any(k in name for k in ("Leg", "Foot", "Toe")):
                f = lm["feet"]["L" if p.x >= 0 else "R"]
                x = f["x"]
                z = mz(p.z)
                if "Toe" in name or p.z < 0.12:
                    y = float(np.interp(p.y, [-0.2, 0.06], [f["y0"], f["y1"]]))
                else:
                    y = slice_y(V, H, z)
            else:
                x, z = 0.0, mz(p.z)
                y = slice_y(V, H, z)
            pts.append(Vector((x, y, z)))
        out[name] = tuple(pts)
    # a joint is ONE point: where the template's child head touched its parent's tail, they stay together
    for b in template()["bones"]:
        if b["parent"] and (tw[b["name"]][0] - tw[b["parent"]][1]).length < 0.005:
            out[b["name"]] = (out[b["parent"]][1].copy(), out[b["name"]][1])
    return out


HOW = {"Hips": "crotch height + body centre", "Spine": "template proportion between the crotch and the neck", "Spine1": "template proportion", "Spine2": "template proportion",
       "Neck": "narrowest torso slice (neck height)", "Head": "from the neck up to the top of the head", "HeadTop_End": "top of the head",
       "LeftShoulder": "template proportion of the arm", "RightShoulder": "template proportion of the arm",
       "LeftArm": "arm span: template proportion (shoulder joint)", "RightArm": "arm span: template proportion (shoulder joint)",
       "LeftForeArm": "template proportion of the arm (elbow): confirm with rig_motion arms_forward", "RightForeArm": "template proportion of the arm (elbow): confirm with rig_motion arms_forward",
       "LeftHand": "measured fingertip reach (wrist at the template proportion)", "RightHand": "measured fingertip reach (wrist at the template proportion)",
       "LeftUpLeg": "crotch height, foot centre line", "RightUpLeg": "crotch height, foot centre line",
       "LeftLeg": "template proportion of the leg (knee): confirm with rig_motion squat", "RightLeg": "template proportion of the leg (knee): confirm with rig_motion squat",
       "LeftFoot": "narrowest leg slice above the foot (ankle)", "RightFoot": "narrowest leg slice above the foot (ankle)",
       "LeftToeBase": "foot length", "RightToeBase": "foot length", "LeftToe_End": "foot length", "RightToe_End": "foot length"}


# ---------------------------------------------------------------- building and binding
def build_armature(tpl, fitted, name="rig"):
    scn = bpy.context.scene
    m = object_matrix(tpl)
    inv = m.inverted()
    data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, data)
    scn.collection.objects.link(arm)
    arm.rotation_euler = tuple(tpl["object"]["rotation_euler"])
    arm.scale = tuple(tpl["object"]["scale"])
    L.activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    for b in tpl["bones"]:
        e = eb.new(PREFIX + b["name"])
        h, t = fitted[b["name"]]
        e.head, e.tail = inv @ h, inv @ t
        e.roll = b["roll"]
    for b in tpl["bones"]:
        if b["parent"]:
            eb[PREFIX + b["name"]].parent = eb[PREFIX + b["parent"]]
    bpy.ops.object.mode_set(mode="OBJECT")
    data.display_type = "STICK"
    return arm


def unbind(body):
    for md in [m for m in body.modifiers if m.type == "ARMATURE"]:
        body.modifiers.remove(md)
    body.vertex_groups.clear()
    if body.parent is not None:
        mw = body.matrix_world.copy()
        body.parent = None
        body.matrix_world = mw


def bind(body, arm):
    """parent `body` to `arm` with automatic weights (rest pose). Returns weight statistics."""
    unbind(body)
    for b in arm.pose.bones:
        b.rotation_mode = "QUATERNION"
        b.location, b.rotation_quaternion, b.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
    arm.data.pose_position = "REST"
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    arm.data.pose_position = "POSE"
    return weight_stats(body, arm)


def weight_stats(body, arm):
    me = body.data
    n = len(me.vertices)
    unweighted, maxinf, per_group = 0, 0, {}
    names = {g.index: g.name for g in body.vertex_groups}
    for v in me.vertices:
        gs = [g for g in v.groups if g.weight > 0.01]
        if not gs:
            unweighted += 1
        maxinf = max(maxinf, len(gs))
        for g in gs:
            if g.weight >= 0.5:
                per_group[names[g.group]] = per_group.get(names[g.group], 0) + 1
    return {"vertices": n, "unweighted": unweighted, "max_influences": maxinf, "vertex_groups": len(body.vertex_groups),
            "dominant_vertices_per_bone": dict(sorted(per_group.items(), key=lambda kv: -kv[1]))}


def joints_mm(arm):
    """head and tail of every bone, world millimetres (rest)."""
    mw = arm.matrix_world
    out = {}
    for b in arm.data.bones:
        out[b.name.split(":", 1)[1]] = {"head_mm": [round(x * 1000, 1) for x in (mw @ b.head_local)], "tail_mm": [round(x * 1000, 1) for x in (mw @ b.tail_local)]}
    return out


def find_rig(name="rig"):
    arm = bpy.data.objects.get(name)
    if arm is None or arm.type != "ARMATURE":
        raise RuntimeError("no rig in this scene: run rig_biped first")
    return arm


# ---------------------------------------------------------------- posing and measuring
def evaluated_verts(body):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    m = np.array(body.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def reset_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.location, pb.rotation_quaternion, pb.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
    bpy.context.view_layer.update()


def rotate_world(arm, bone, axis, deg):
    """rotate pose bone `bone` (and so its children) by `deg` degrees about the world axis `axis` through its head (parents already posed)."""
    pb = arm.pose.bones[PREFIX + bone]
    bpy.context.view_layer.update()
    mw = arm.matrix_world
    head = mw @ pb.head
    R = Matrix.Rotation(math.radians(deg), 4, Vector(axis))
    piv = Matrix.Translation(head) @ R @ Matrix.Translation(-head)
    pb.matrix = mw.inverted() @ piv @ (mw @ pb.matrix)
    bpy.context.view_layer.update()


def tri_index(body):
    me = body.data
    me.calc_loop_triangles()
    return np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)


def regions(rest, tris, arm, radius):
    """for each gated joint: the triangle ids and the unique edges within `radius` of the joint (rest)."""
    out = {}
    mw = arm.matrix_world
    cen = rest[tris].mean(axis=1)
    for key, bone in LIMB_JOINTS.items():
        pb = arm.data.bones.get(PREFIX + bone)
        if pb is None:
            continue
        c = np.array(mw @ pb.head_local)
        ids = np.nonzero(np.linalg.norm(cen - c, axis=1) < radius)[0]
        if len(ids) < 10:
            continue
        t = tris[ids]
        e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
        e = np.unique(np.sort(e, axis=1), axis=0)
        out[key] = {"bone": bone, "tris": ids, "edges": e, "rest_head": c}
    return out


def seg_dist(P, a, b):
    """distance from points P (n,3) to the segment a-b."""
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(float(ab @ ab), 1e-12), 0.0, 1.0)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def joint_metrics(rest, posed, regs, arm, tris):
    """per gated joint: worst stretch / compression of the edges around it, and the change of a local thickness proxy: for the skin vertices
    around the joint, the mean squared distance to the two bones that meet at the joint (the bone and its parent, as segments): it is
    proportional to the cross-section area, so a limb that pinches or collapses at the bend loses it, one that bulges gains it.
    Rest against posed; the bones are the rest bones and the posed bones."""
    mw = arm.matrix_world
    res = {}
    for key, r in regs.items():
        e = r["edges"]
        l0 = np.linalg.norm(rest[e[:, 0]] - rest[e[:, 1]], axis=1)
        l1 = np.linalg.norm(posed[e[:, 0]] - posed[e[:, 1]], axis=1)
        ok = l0 > 1e-6
        ratio = l1[ok] / l0[ok]
        pv = np.unique(tris[r["tris"]])
        bones = [R_ for R_ in (arm.data.bones[PREFIX + r["bone"]], arm.data.bones[PREFIX + r["bone"]].parent) if R_ is not None]
        d0 = np.full(len(pv), np.inf)
        d1 = np.full(len(pv), np.inf)
        for bn in bones:
            pb = arm.pose.bones[bn.name]
            d0 = np.minimum(d0, seg_dist(rest[pv], np.array(mw @ bn.head_local), np.array(mw @ bn.tail_local)))
            d1 = np.minimum(d1, seg_dist(posed[pv], np.array(mw @ pb.head), np.array(mw @ pb.tail)))
        change = ((d1 ** 2).mean() / max((d0 ** 2).mean(), 1e-12) - 1.0) * 100
        res[key] = {"worst_stretch_pct": round(float(max(0.0, ratio.max() - 1) * 100), 1), "worst_compression_pct": round(float(max(0.0, 1 - ratio.min()) * 100), 1),
                    "p99_stretch_pct": round(float(max(0.0, np.percentile(ratio, 99) - 1) * 100), 1),
                    "volume_loss_pct": round(float(max(0.0, -change)), 1), "volume_gain_pct": round(float(max(0.0, change)), 1), "edges": int(len(e))}
    return res


# ---------------------------------------------------------------- pictures
def strip_png(scn, body, arm, frames, path, view="front", res=384, set_frame=None, target=None, size=None, vertex_colours=False):
    """render `frames` poses side by side into one PNG. `set_frame(i, f)` poses the rig for frame entry f. Workbench, same look as the watch.
    `target` (world point, or a function of the frame entry f giving one) and `size` (metres across) frame a close-up instead of the whole body; `vertex_colours` shows the body's active colour attribute."""
    import kit2_modes as M
    M.workbench(scn, res)
    if vertex_colours:
        scn.display.shading.color_type = "VERTEX"
    scn.render.image_settings.file_format = "PNG"
    V = world_verts(body)
    zmin, zmax = float(V[:, 2].min()), float(V[:, 2].max())
    H = zmax - zmin
    tgt = Vector((0, 0, zmin + 0.5 * H))
    dirs = {"front": (0, -1, 0), "side": (1, 0, 0), "three_quarter": (0.7, -0.7, 0.1), "back": (0, 1, 0)}
    d = Vector(dirs[view]).normalized()
    cam = bpy.data.objects.new("StripCam", bpy.data.cameras.new("StripCam"))
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam.data.angle = math.radians(35)
    cam.data.clip_start, cam.data.clip_end = 0.02, 60
    wid = float(size) if size else max(H, float(V[:, 0].max() - V[:, 0].min())) * 1.15
    cam.location = tgt + d * (wid / 2 / math.tan(math.radians(17.5)))
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    for o in scn.objects:
        o.hide_render = o is not body
    tiles = []
    tmp = path[:-4] + "_tmp.png"
    for i, f in enumerate(frames):
        set_frame(i, f)
        if target is not None:
            tg = Vector(target(f) if callable(target) else target)
            cam.location = tg + d * (wid / 2 / math.tan(math.radians(17.5)))
        scn.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(tmp)
        w, h = im.size
        tiles.append(np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4))
        bpy.data.images.remove(im)
    os.remove(tmp)
    row = np.concatenate(tiles, axis=1)
    img = bpy.data.images.new("strip", row.shape[1], row.shape[0], alpha=True)
    img.pixels = row.ravel()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.objects.remove(cam, do_unlink=True)
    return path