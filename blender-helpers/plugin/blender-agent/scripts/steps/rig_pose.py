"""rig_pose — explicit joint-angle poses and the isolated hip/knee tests, with numbers and pictures. Saves nothing.

Poses the rig exactly as asked (no clip needed; any clip on the rig, its NLA tracks AND an action assigned directly, is set aside while it runs and put back at the end: `animation_set_aside` in the report says what), measures how the skin copes and renders a strip.
Presets (`tests`), each rotating only what its name says (angles about the world X axis through the bone's head; positive knee flexion = the shin swings backward):
  hip_lift_left_straight / hip_lift_right_straight    thigh forward 60, knee straight
  hip_lift_left_bent / hip_lift_right_bent            thigh forward 60, knee bent 90
  hip_lift_left_90 / hip_lift_right_90                thigh forward 90, knee straight
  knee_flex_left_0 / _45 / _90 / _120  (and right)    thigh down, the knee flexed to that many degrees
Or give your own `poses`: [{"name": "x", "ops": [{"bone": "LeftUpLeg", "axis": "x", "deg": -45}], "joints": ["hip_L"], "view": "side"}]; axis is "x", "y", "z" or [x, y, z] (world); ops run in order, parents first.

params:
  tests     list of preset names (default: none)
  poses     your own poses (above)
  frames    pictures per strip (default 4: rest, 1/3, 2/3, full)
  view      front | side | three_quarter | back (default side for leg tests)
  res       one picture px (default 384); strip file out/rigpose-<name>.png
  radius_pct   region radius, percent of the height (default 8)
  hotspots  how many clusters of flagged edges to list per pose (default 8; 0 = none): the folded edges and the edges stretched more than `stretch_over_pct` (default 50), grouped when within `cluster_mm` (default 30) of each other
  mark      true: paint the skin in the pictures grey, with the folded places RED and the stretched places ORANGE (the vertices within `mark_mm`, default 8, of a flagged edge, as the pose at full strength flags them; the same vertices are painted in every frame)
  close     a close-up instead of the whole body: {"c": [x, y, z], "size_mm": 250} (the centre in mm at rest, how wide the picture covers), or {"hotspot": "folded" | "stretched", "index": 0, "size_mm": 250} (frames the cluster with that rank).
            The centre follows the part as it moves (from its rest position at the first frame to its position at full strength).
Returns per pose: joints (stretch, compression, p99 stretch, volume loss/gain around hip/knee/shoulder/elbow/spine/neck), worst, hotspots {folded, stretched}: each a list of clusters with edges, centre_rest_mm, centre_posed_mm (world), worst (crease growth deg / stretch %), nearest_bone and vertices, ranked by severity; leak_mm (the largest movement of the OTHER side's vertices that are farther than 40 mm from the midline: 0 = no
opposite-limb influence), folded_edges (adjacent triangle pairs whose crease grew by more than 120 degrees against rest: a fold or an inverted patch; a limb turning rigidly gives 0), max_vertex_move_mm, picture.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402

AX = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}


def preset(name):
    parts = name.split("_")
    side = "Left" if "left" in parts else "Right" if "right" in parts else None
    if side is None:
        raise RuntimeError(f"unknown test {name}")
    j = "hip_L" if side == "Left" else "hip_R"
    k = "knee_L" if side == "Left" else "knee_R"
    if name.startswith("hip_lift") and name.endswith("straight"):
        return {"ops": [(f"{side}UpLeg", "x", -60)], "joints": [j, k], "side": side}
    if name.startswith("hip_lift") and name.endswith("bent"):
        return {"ops": [(f"{side}UpLeg", "x", -60), (f"{side}Leg", "x", 90)], "joints": [j, k], "side": side}
    if name.startswith("hip_lift") and name.endswith("90"):
        return {"ops": [(f"{side}UpLeg", "x", -90)], "joints": [j, k], "side": side}
    if name.startswith("knee_flex"):
        return {"ops": [(f"{side}Leg", "x", float(parts[-1]))], "joints": [k, j], "side": side}
    raise RuntimeError(f"unknown test {name}")


def apply(arm, ops, t):
    R.reset_pose(arm)
    for bone, axis, deg in ops:
        R.rotate_world(arm, bone, AX[axis] if isinstance(axis, str) else tuple(axis), deg * t)


def cluster(mid_rest, mid_posed, vals, rest_bones, radius, top):
    """greedy clusters of flagged edges (worst first) within `radius` metres of each other (posed midpoints): [{...}]"""
    out, used = [], np.zeros(len(vals), bool)
    for i in np.argsort(-vals):
        if used[i]:
            continue
        near = (~used) & (np.linalg.norm(mid_posed - mid_posed[i], axis=1) <= radius)
        used |= near
        cr, cp = mid_rest[near].mean(0), mid_posed[near].mean(0)
        d = [(R.seg_dist(cr[None], a, b)[0], n) for n, a, b in rest_bones]
        out.append({"edges": int(near.sum()), "worst": round(float(vals[near].max()), 1), "centre_rest_mm": [round(float(x) * 1000, 1) for x in cr], "centre_posed_mm": [round(float(x) * 1000, 1) for x in cp],
                    "nearest_bone": min(d)[1][len(R.PREFIX):], "_rest": cr, "_posed": cp, "_near": near})
        if len(out) >= top:
            break
    return out


def main():
    arm = R.find_rig()
    body = bpy.data.objects[L.param("body", "body")]
    scn = bpy.context.scene
    todo = []
    for t in L.param("tests") or []:
        p = preset(t)
        todo.append((t, p["ops"], p["joints"], "side", p["side"]))
    for p in L.param("poses") or []:
        ops = [(o["bone"], o.get("axis", "x"), float(o["deg"])) for o in p["ops"]]
        for _, ax, _ in ops:
            if isinstance(ax, str) and ax not in AX:
                raise RuntimeError('axis must be "x", "y", "z" or [x, y, z]')
        bones = {o[0] for o in ops}
        side = "Left" if all(b.startswith("Left") for b in bones) else "Right" if all(b.startswith("Right") for b in bones) else None
        todo.append((p.get("name", "pose"), ops, p.get("joints", []), p.get("view", "side"), side))
    if not todo:
        raise RuntimeError("give tests (preset names) and/or poses")
    nf = int(L.param("frames", 4))
    ad = arm.animation_data
    muted = [(t, t.mute) for t in (ad.nla_tracks if ad else [])]
    for t, _ in muted:
        t.mute = True
    action_was = ad.action if ad else None  # an active action would rewrite the pose at every frame change: set it aside, put it back at the end
    if ad:
        ad.action = None
    R.reset_pose(arm)
    rest = R.evaluated_verts(body)
    tris = R.tri_index(body)
    H = float(rest[:, 2].max() - rest[:, 2].min())
    regs = R.regions(rest, tris, arm, float(L.param("radius_pct", 8)) / 100 * H)
    out, files = {}, []

    def normals(v):
        a, b, c = v[tris[:, 0]], v[tris[:, 1]], v[tris[:, 2]]
        n = np.cross(b - a, c - a)
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    n0 = normals(rest)
    # adjacent triangle pairs (sharing an edge): a fold is a crease that grew by more than 120 degrees (a limb turning rigidly changes no crease)
    e3 = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    fid = np.concatenate([np.arange(len(tris))] * 3)
    srt = np.sort(e3, axis=1)
    order = np.lexsort((srt[:, 1], srt[:, 0]))
    srt, fid = srt[order], fid[order]
    same = (srt[1:] == srt[:-1]).all(1)
    fa, fb = fid[:-1][same], fid[1:][same]

    def crease(n):
        return np.degrees(np.arccos(np.clip((n[fa] * n[fb]).sum(1), -1, 1)))
    c0 = crease(n0)
    fe_all = srt[:-1][same]  # the shared edge of each adjacent pair, in the order of `crease`
    uniq = np.unique(srt, axis=0)
    rest_bones = [(b.name, np.array(arm.matrix_world @ b.head_local), np.array(arm.matrix_world @ b.tail_local)) for b in arm.data.bones if b.use_deform]
    for name, ops, joints, view, side in todo:
        apply(arm, ops, 1.0)
        posed = R.evaluated_verts(body)
        met = R.joint_metrics(rest, posed, regs, arm, tris)
        sel = {k: v for k, v in met.items() if (not joints) or k in joints}
        mv = np.linalg.norm(posed - rest, axis=1)
        leak = None
        if side:
            other = (rest[:, 0] < -0.04) if side == "Left" else (rest[:, 0] > 0.04)
            leak = round(float(mv[other].max() * 1000), 2) if other.any() else 0.0
        growth = crease(normals(posed)) - c0
        fmask = growth > 120
        folded = int(fmask.sum())
        hs, marks_f, marks_s = {}, [], []
        ntop = int(L.param("hotspots", 8))
        if ntop > 0 or L.param("mark") or L.param("close"):
            rl = np.linalg.norm(posed[uniq[:, 0]] - posed[uniq[:, 1]], axis=1) / np.maximum(np.linalg.norm(rest[uniq[:, 0]] - rest[uniq[:, 1]], axis=1), 1e-9)
            smask = (rl - 1) * 100 > float(L.param("stretch_over_pct", 50))
            cl = float(L.param("cluster_mm", 30)) / 1000
            fe = fe_all[fmask]
            hs["folded"] = cluster((rest[fe[:, 0]] + rest[fe[:, 1]]) / 2, (posed[fe[:, 0]] + posed[fe[:, 1]]) / 2, growth[fmask], rest_bones, cl, max(ntop, 1)) if len(fe) else []
            se = uniq[smask]
            hs["stretched"] = cluster((rest[se[:, 0]] + rest[se[:, 1]]) / 2, (posed[se[:, 0]] + posed[se[:, 1]]) / 2, (rl[smask] - 1) * 100, rest_bones, cl, max(ntop, 1)) if len(se) else []
            marks_f, marks_s = fe, se
        close = L.param("close")
        target = size = None
        if close:
            size = float(close.get("size_mm", 250)) / 1000
            if "hotspot" in close:
                lst = hs.get(close["hotspot"], [])
                k = int(close.get("index", 0))
                if k >= len(lst):
                    raise RuntimeError(f'close: no {close["hotspot"]} hotspot number {k} in pose {name} ({len(lst)} found)')
                a, b = lst[k]["_rest"], lst[k]["_posed"]
            else:
                a = b = np.array([float(x) / 1000 for x in close["c"]])
            target = (lambda t, a=a, b=b: a + (b - a) * t)
        vc = bool(L.param("mark"))
        if vc:
            col = np.tile(np.array([0.62, 0.62, 0.64, 1.0], np.float32), (len(body.data.vertices), 1))
            from mathutils.kdtree import KDTree
            kd = KDTree(len(rest))
            for i, p in enumerate(rest):
                kd.insert(p, i)
            kd.balance()
            mr = float(L.param("mark_mm", 8)) / 1000
            for edges, rgb in ((marks_s, (1.0, 0.55, 0.05, 1.0)), (marks_f, (0.95, 0.08, 0.08, 1.0))):
                for a_, b_ in edges:
                    for end in (a_, b_):
                        for _, j, _d in kd.find_range(rest[end], mr):
                            col[j] = rgb
            ca = body.data.color_attributes.get("rigpose-marks") or body.data.color_attributes.new("rigpose-marks", "FLOAT_COLOR", "POINT")
            ca.data.foreach_set("color", col.ravel())
            body.data.color_attributes.active_color = ca
        path = os.path.join(L.ARGS["out_dir"], f"rigpose-{name}.png")
        R.strip_png(scn, body, arm, [i / max(nf - 1, 1) for i in range(nf)], path, view=L.param("view") or view, res=int(L.param("res", 384)), set_frame=lambda i, t, o=ops: apply(arm, o, t), target=target, size=size, vertex_colours=vc)
        files.append(path)
        out[name] = {"ops": [{"bone": b, "axis": a, "deg": d} for b, a, d in ops], "joints": sel,
                     "worst": {"stretch_pct": max((v["worst_stretch_pct"] for v in sel.values()), default=0), "p99_stretch_pct": max((v["p99_stretch_pct"] for v in sel.values()), default=0),
                               "compression_pct": max((v["worst_compression_pct"] for v in sel.values()), default=0), "volume_loss_pct": max((v["volume_loss_pct"] for v in sel.values()), default=0)},
                     "leak_mm": leak, "folded_edges": folded, "hotspots": {k: [{kk: vv for kk, vv in c.items() if not kk.startswith("_")} for c in v][:ntop] for k, v in hs.items()} if ntop > 0 else None, "max_vertex_move_mm": round(float(mv.max() * 1000), 1), "picture": os.path.basename(path)}
    R.reset_pose(arm)
    for t, was in muted:
        t.mute = was
    if ad:
        ad.action = action_was
    L.finish({"poses": out, "animation_set_aside": {"action": action_was.name if action_was else None, "nla_tracks_muted": len(muted)}, "rendered": [os.path.basename(f) for f in files]}, files=files)


L.run(main)
