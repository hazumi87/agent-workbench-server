"""hand_pose — pose the finger bones (open, half, fist, one digit at a time, or your own angles), measure how the skin copes, and render clay pictures of the hand. Reads only (the rig is put back at rest); saves no checkpoint.

Finger poses are bends of the finger segments toward the palm about the axis across the finger (and a fan about the palm normal), measured from the REST positions of the finger bones: the existing bones and the body are not changed. The measures are for the hand's own vertices (those weighted to the finger bones):
how far its edges stretch or squash against rest (largest and 99th percentile), creases that fold (crease growth over 120 degrees), and fingertips or segments that come within `contact_mm` of another finger's skin that were not touching at rest (interpenetration risk).

params:
  armature   the rig (default "rig"); body: the mesh (default "body"); side: "left" (default) or "right"
  poses      a list of {"name": "fist", "pose": "fist" | {"Index": [a1, a2, a3], "Middle": [...], "Ring": [...], "Pinky": [...], "Thumb": [...]}, "spread_deg": 0, "thumb_swing_deg": 0}: degrees of bend of segment 1, 2, 3 of each finger toward the palm (negative = backward);
             presets: open, half (about half-closed), fist, hook (middle joints only), point (index straight, others fist), thumbs_up-like "thumb_out" (fingers fist, thumb out), pinch (thumb and index meet), spread (fingers fanned 12 degrees)
             or the single-digit tests index_only, middle_only, ring_only, pinky_only, thumb_only (that digit curls 70-90 degrees, the others stay open)
             Default: open, half, fist, index_only, thumb_only.
  palm       [x, y, z] the direction the palm faces (default [0, 0, -1], palms down in a T-pose)
  views      pictures per pose: a list of "palm" | "back" | "thumb" | "oblique" (default ["palm", "thumb"]); res px (default 480); out/handpose-<pose>-<view>.png and one strip per pose
  shading    "clay" (default, Workbench) or "pbr": the pictures show the mesh with its materials (Cycles on the CPU, Standard view transform); needs a mesh with materials (the joined body)
  cameras    your own cameras instead of `views`: a list of {"name": "down45", "offset_mm": [dx, dy, dz], "centre_mm": [x, y, z], "fov_deg": 30} (a perspective camera that far from the centre, looking at it; both clay and pbr; centre_mm and fov_deg optional per camera, else the top-level ones) or {"name": "mine", "dir": [x, y, z]} (an orthographic view from that direction). The centre can be moved with `centre_mm` [x, y, z]
  samples    PBR samples (default 24); res px as above
  contact_mm how close another finger's skin may come (default 1.5)
Returns per pose: bends (the angles used), skin (edge stretch max / p99 %, compression max %, folded edges, interpenetration candidates), per_digit (the same stretch / compression / fold numbers for each digit's own vertices and edges, with the share of that digit's edges above 30 % stretch), hotspots (the 6 most stretched edges: digit, nearest bone segment, position mm after the pose, rest and posed length mm, stretch %), finger_tips_mm (the finger tips AFTER the pose, world mm), finger_tips_rest_mm (at rest), pictures.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.kdtree import KDTree  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402
from _handview import render_views, render_views_pbr  # noqa: E402

FING = ["Thumb", "Index", "Middle", "Ring", "Pinky"]
PRESETS = {
    "open": {},
    "half": {f: [40, 50, 30] for f in ("Index", "Middle", "Ring", "Pinky")} | {"Thumb": [15, 25, 20]},
    "fist": {f: [85, 100, 65] for f in ("Index", "Middle", "Ring", "Pinky")} | {"Thumb": [30, 45, 55]},
    "hook": {f: [0, 90, 60] for f in ("Index", "Middle", "Ring", "Pinky")},
    "point": {f: [85, 100, 65] for f in ("Middle", "Ring", "Pinky")} | {"Thumb": [30, 45, 55]},
    "thumb_out": {f: [85, 100, 65] for f in ("Index", "Middle", "Ring", "Pinky")},
    "pinch": {"Index": [45, 55, 35], "Thumb": [30, 40, 35]},
    "spread": {},
    "index_only": {"Index": [80, 95, 60]},
    "middle_only": {"Middle": [80, 95, 60]},
    "ring_only": {"Ring": [80, 95, 60]},
    "pinky_only": {"Pinky": [80, 95, 60]},
    "thumb_only": {"Thumb": [35, 50, 55]},
}


def main():
    arm = bpy.data.objects.get(L.param("armature", "rig"))
    body = bpy.data.objects.get(L.param("body", "body"))
    side = L.param("side", "left")
    S = "Left" if side == "left" else "Right"
    pre = R.PREFIX
    if arm is None or body is None:
        raise RuntimeError("need the rig and the body")
    for f in FING:
        if pre + f"{S}Hand{f}1" not in arm.data.bones:
            raise RuntimeError(f"the rig has no finger bones ({S}Hand{f}1 ...): run hand_bones first")
    palm = Vector(L.param("palm", [0, 0, -1])).normalized()
    contact = float(L.param("contact_mm", 1.5)) / 1000
    poses = L.param("poses") or [{"name": n, "pose": n} for n in ("open", "half", "fist", "index_only", "thumb_only")]
    views = L.param("views", ["palm", "thumb"])
    res = int(L.param("res", 480))
    bpy.context.view_layer.update()
    R.reset_pose(arm)
    rest = R.evaluated_verts(body)
    # the hand's vertices: weighted to a finger bone or the Hand bone (>= 0.5 of the total), and their dominant finger
    names = [g.name for g in body.vertex_groups]
    fgroups = {pre + f"{S}Hand{f}{i}": f for f in FING for i in (1, 2, 3)}
    hand_g = pre + f"{S}Hand"
    n = len(body.data.vertices)
    dom = np.full(n, "", dtype=object)
    wf = np.zeros(n)
    for vv in body.data.vertices:
        best, bw = None, 0.0
        tot = 0.0
        for g in vv.groups:
            nm = names[g.group]
            if nm in fgroups:
                tot += g.weight
        for g in vv.groups:
            nm = names[g.group]
            if nm in fgroups and g.weight > bw:
                best, bw = fgroups[nm], g.weight
        if tot > 0.5:
            dom[vv.index] = best
            wf[vv.index] = tot
    hv = np.nonzero(dom != "")[0]
    if len(hv) < 50:
        raise RuntimeError("the body has too few vertices weighted to the finger bones")
    # edges among the hand's vertices
    me = body.data
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    e = e.reshape(-1, 2)
    inh = np.zeros(n, bool)
    inh[hv] = True
    e = e[inh[e[:, 0]] & inh[e[:, 1]]]
    l0 = np.linalg.norm(rest[e[:, 0]] - rest[e[:, 1]], axis=1)
    okl = l0 > 1e-4
    me.calc_loop_triangles()
    tris = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)
    # adjacent-triangle pairs among the hand for the fold test
    sel = inh[tris].all(1)
    tr = tris[sel]

    def normals(Vp):
        a, b, c = Vp[tr[:, 0]], Vp[tr[:, 1]], Vp[tr[:, 2]]
        nn = np.cross(b - a, c - a)
        return nn / np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-12)
    e3 = np.concatenate([tr[:, [0, 1]], tr[:, [1, 2]], tr[:, [2, 0]]])
    fid = np.concatenate([np.arange(len(tr))] * 3)
    srt = np.sort(e3, axis=1)
    order = np.lexsort((srt[:, 1], srt[:, 0]))
    srt, fid = srt[order], fid[order]
    same = (srt[1:] == srt[:-1]).all(1)
    fa, fb2 = fid[:-1][same], fid[1:][same]

    def crease(nn):
        return np.degrees(np.arccos(np.clip((nn[fa] * nn[fb2]).sum(1), -1, 1)))
    c0 = crease(normals(rest))
    # rest geometry of the bones
    def hd(nm):
        return np.array(arm.matrix_world @ arm.data.bones[pre + nm].head_local)

    def tl(nm):
        return np.array(arm.matrix_world @ arm.data.bones[pre + nm].tail_local)

    def tl_posed(nm):
        return np.array(arm.matrix_world @ arm.pose.bones[pre + nm].tail)
    seg_mid = {f"{S}Hand{f}{i}": (hd(f"{S}Hand{f}{i}") + tl(f"{S}Hand{f}{i}")) / 2 for f in FING for i in (1, 2, 3)}
    seg_names = list(seg_mid)
    seg_pts = np.array([seg_mid[k] for k in seg_names])
    out = {}
    files = []
    ctr = (hd(f"{S}Hand") + tl(f"{S}HandMiddle3")) / 2
    size = float(np.linalg.norm(tl(f"{S}HandMiddle3") - hd(f"{S}Hand")) * 2.4)
    uh = (tl(f"{S}HandMiddle3") - hd(f"{S}Hand"))
    uh /= np.linalg.norm(uh)
    wh_ = np.array(palm)
    vh = np.cross(wh_, uh)
    if side == "right":
        vh = -vh
    vdirs = {"palm": Vector(wh_), "back": Vector(-wh_), "thumb": Vector(vh), "oblique": Vector(wh_ * 0.7 + vh * 0.5 - uh * 0.4)}
    for P in poses:
        name = P.get("name", str(P.get("pose")))
        spec = P.get("pose", name)
        bends = PRESETS[spec] if isinstance(spec, str) else spec
        if isinstance(spec, str) and spec not in PRESETS:
            raise RuntimeError(f"unknown pose {spec}; presets: {', '.join(PRESETS)}")
        R.reset_pose(arm)
        applied = {}
        for f in FING:
            ang = bends.get(f) or [0, 0, 0]
            for i in (1, 2, 3):
                bn = f"{S}Hand{f}{i}"
                head, tail = hd(bn), tl(bn)
                u_f = tail - head
                u_f /= np.linalg.norm(u_f)
                axis = np.cross(u_f, wh_)  # a positive turn about it moves the finger toward the palm side
                nrm = np.linalg.norm(axis)
                if nrm < 1e-6:
                    continue
                axis /= nrm
                if ang[i - 1]:
                    R.rotate_world(arm, bn, axis.tolist(), float(ang[i - 1]))
                    applied[bn] = round(float(ang[i - 1]), 1)
        if P.get("spread_deg") or spec == "spread":
            sd = float(P.get("spread_deg", 12 if spec == "spread" else 0))
            mid = {"Pinky": -2, "Ring": -1, "Middle": 0, "Index": 1, "Thumb": 2}
            for f in ("Index", "Ring", "Pinky"):
                bn = f"{S}Hand{f}1"
                R.rotate_world(arm, bn, wh_.tolist(), sd * mid[f] * (1 if side == "left" else -1))
        if P.get("thumb_swing_deg"):
            R.rotate_world(arm, f"{S}HandThumb1", wh_.tolist(), float(P["thumb_swing_deg"]))
        bpy.context.view_layer.update()
        posed = R.evaluated_verts(body)
        l1 = np.linalg.norm(posed[e[:, 0]] - posed[e[:, 1]], axis=1)
        ratio = l1[okl] / l0[okl]
        folded = int(((crease(normals(posed)) - c0) > 120).sum())
        # interpenetration candidates: a hand vertex of one finger within `contact` of a vertex of ANOTHER finger, not so at rest
        kd = KDTree(len(hv))
        for k, vi in enumerate(hv):
            kd.insert(posed[vi], k)
        kd.balance()
        kd0 = KDTree(len(hv))
        for k, vi in enumerate(hv):
            kd0.insert(rest[vi], k)
        kd0.balance()
        cand = 0
        for k, vi in enumerate(hv):
            for _, j, _d in kd.find_range(posed[vi], contact):
                if dom[hv[j]] != dom[vi] and (hv[j] != vi):
                    near0 = any(jj == j for _, jj, _dd in kd0.find_range(rest[vi], contact))
                    if not near0:
                        cand += 1
        digit_of = dom[hv]
        edom0 = dom[e[:, 0]]
        edom1 = dom[e[:, 1]]
        per_digit = {}
        crv = crease(normals(posed)) - c0
        fold_dom = dom[tr[fa][:, 0]]
        for f in FING:
            em = (edom0 == f) & (edom1 == f) & okl
            if not em.any():
                continue
            rr = l1[em] / l0[em]
            per_digit[f] = {"edges": int(em.sum()), "stretch_max_pct": round(float(max(0.0, rr.max() - 1) * 100), 1), "stretch_p99_pct": round(float(max(0.0, np.percentile(rr, 99) - 1) * 100), 1),
                            "compression_max_pct": round(float(max(0.0, 1 - rr.min()) * 100), 1), "share_over_30pct_stretch": round(float((rr > 1.3).mean()), 3),
                            "folded_edges": int(((crv > 120) & (fold_dom == f)).sum())}
        ratio_all = np.where(okl, l1 / np.maximum(l0, 1e-9), 0)
        hot = []
        for k in np.argsort(-ratio_all)[:6]:
            mid = (posed[e[k, 0]] + posed[e[k, 1]]) / 2
            seg = seg_names[int(np.argmin(np.linalg.norm(seg_pts - (rest[e[k, 0]] + rest[e[k, 1]]) / 2, axis=1)))]
            hot.append({"digit": str(dom[e[k, 0]] or dom[e[k, 1]]), "nearest_segment": pre + seg, "position_mm": [round(float(x) * 1000, 1) for x in mid],
                        "rest_len_mm": round(float(l0[k]) * 1000, 2), "posed_len_mm": round(float(l1[k]) * 1000, 2), "stretch_pct": round(float(ratio_all[k] - 1) * 100, 1)})
        pics = []
        if views:
            os.makedirs(L.ARGS["out_dir"], exist_ok=True)
            cams = L.param("cameras")
            top = Vector([x / 1000 for x in L.param("centre_mm")]) if L.param("centre_mm") else Vector(ctr)
            shade = L.param("shading", "clay")
            pics = []
            if not cams:
                dd = {v: vdirs[v] for v in views}
                if shade == "pbr":
                    pics += render_views_pbr([body], top, size, f"handpose-{name}", res, dd, samples=int(L.param("samples", 24)))
                else:
                    pics += render_views_for(body, arm, top, size, f"handpose-{name}", res, dd)
            for c_ in (cams or []):
                cen = Vector([x / 1000 for x in c_["centre_mm"]]) if c_.get("centre_mm") else top  # a camera can carry its own centre_mm; otherwise the top-level one
                fov = float(c_.get("fov_deg", L.param("fov_deg", 30)))
                if "offset_mm" in c_:
                    oo, dd = {c_["name"]: [x / 1000 for x in c_["offset_mm"]]}, {}
                else:
                    oo, dd = None, {c_["name"]: Vector(c_["dir"])}
                if shade == "pbr":
                    pics += render_views_pbr([body], cen, size, f"handpose-{name}", res, dd, samples=int(L.param("samples", 24)), perspective_fov_deg=fov, cam_offsets=oo)
                else:
                    pics += render_views([body], cen, size, f"handpose-{name}", res, dd, cam_offsets=oo, fov_deg=fov)
            files += pics
        out[name] = {"bends": applied, "skin": {"edge_stretch_max_pct": round(float(max(0.0, ratio.max() - 1) * 100), 1), "edge_stretch_p99_pct": round(float(max(0.0, np.percentile(ratio, 99) - 1) * 100), 1),
                                                "edge_compression_max_pct": round(float(max(0.0, 1 - ratio.min()) * 100), 1), "folded_edges": folded, "contact_candidates_pairs": int(cand), "hand_vertices": int(len(hv))},
                     "per_digit": per_digit, "hotspots": hot,
                     "finger_tips_mm": {f: [round(float(x) * 1000, 1) for x in tl_posed(f"{S}Hand{f}3")] for f in FING},
                     "finger_tips_rest_mm": {f: [round(float(x) * 1000, 1) for x in tl(f"{S}Hand{f}3")] for f in FING},
                     "pictures": [os.path.basename(p) for p in pics]}
    R.reset_pose(arm)
    L.finish({"poses": out}, files=files)


def render_views_for(body, arm, ctr, size, prefix, res, dirs):
    """the body (all of it; the camera is on the hand) from the given directions"""
    return render_views([body], Vector(ctr), size, prefix, res, dirs)


L.run(main)
