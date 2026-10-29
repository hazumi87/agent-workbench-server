"""wrist_flex — bend the wrist (the Hand bone) through a set of angles and measure whether the cuff keeps the join covered: the cuff's open rim (the body's boundary edge at the wrist) against the new hand's skin. Reads only (the rig is put back at rest); saves no checkpoint. Run after hand_attach (the hand joined into the body).

For each pose it measures, for every rim vertex, the distance to the nearest vertex of the hand's skin, and where the hand's wrist end lies relative to the rim plane along the forearm axis (the part of the hand that must stay behind the rim to be hidden), and renders closeups of the rim.

params:
  armature  the rig (default "rig"); body: the joined mesh (default "body"); side: "left" (default) or "right"
  hand_slot the body's material slot that holds the hand's skin (default: the last slot that is not a cuff lining)
  poses     list of {"name": "flex40", "flex_deg": 40, "deviate_deg": 0, "twist_deg": 0}: flex_deg bends the hand toward the palm side (negative = toward the back), deviate_deg toward the thumb side (negative = pinky side), twist_deg turns it about the forearm axis. Default: rest, flexp40, flexm40, devp20, devm20, twistp30, twistm30 (p = +, m = -). The name goes into the picture file names: anything but letters, digits, _ and - is replaced (+ becomes p)
  palm      [x, y, z] the direction the palm faces (default [0, 0, -1])
  (when hand_attach made a collar, lining_mm, the rim is where the collar's faces, material cuff-lining*, meet the body's own faces; otherwise the open boundary)
  rim_radius_mm, rim_zone_mm  rim vertices = boundary-edge vertices of the body's own faces within rim_radius_mm of the forearm axis (default 60) and between the hand's rearmost point and rim_zone_mm in front of it, along the axis (default 35)
  views     closeups per pose: "back", "palm", "thumb", "oblique", "end" (from the hand's side looking along the forearm into the cuff), "end_oblique" (default ["back", "thumb"]); res px (default 480)
Returns per pose:
  clearance_mm  THE sleeve-to-hand measure. At the cuff's front plane (the plane of the rim's outer edge vertices) the hand is sliced; for every outer-edge rim vertex: its radius from the rim's centre minus the radius of the hand's section outline in the same direction. Positive = a gap between sleeve and hand there (what shows as a dark wedge), negative = the hand reaches past the rim. max / mean / min over the rim and by side (palm_side, back_side, thumb_side, pinky_side), plus hand_section_at_rim (breadth, thickness, centre of the hand's cross-section at that plane, a true slice). "the hand does not reach the cuff's front plane" when it ends behind it.
  hand_end_behind_rim_mm  the hand's rearmost vertices' along-axis position minus the rim's mean plane; negative = the hand's end is inside the sleeve.
  nearest_hand_vertex_mm  for each rim vertex the 3D distance to the nearest hand vertex (max / mean / p95): a rough closeness, NOT a clearance (it grows with how sparse the hand's vertices are).
  rim_vertex_spacing_mm  the largest distance between neighbouring rim vertices around the loop (its own sampling, NOT an opening): largest_gap, largest_gap_at_rest, largest_increase = how far neighbours moved apart when the wrist bent.
  pictures; plus rim (vertex count, radius range, along-axis range mm).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.kdtree import KDTree  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402
from _handview import render_views  # noqa: E402
from _slice import slice_points, section_stats, outline_radius  # noqa: E402


def main():
    arm = bpy.data.objects.get(L.param("armature", "rig"))
    body = bpy.data.objects.get(L.param("body", "body"))
    side = L.param("side", "left")
    S = "Left" if side == "left" else "Right"
    pre = R.PREFIX
    if arm is None or body is None:
        raise RuntimeError("need the rig and the body")
    me = body.data
    non_lining = [i for i, m_ in enumerate(me.materials) if not (m_ is not None and m_.name.startswith("cuff-lining"))]
    slot = int(L.param("hand_slot", non_lining[-1] if non_lining else len(me.materials) - 1))  # the last material that is not a cuff lining
    if len(me.materials) < 2:
        raise RuntimeError("the body has one material slot: run hand_attach (join) first")
    hb = arm.data.bones[pre + S + "Hand"]
    fb = arm.data.bones[pre + S + "ForeArm"]
    mw = arm.matrix_world
    wrist = np.array(mw @ hb.head_local)
    u = wrist - np.array(mw @ fb.head_local)
    u /= np.linalg.norm(u)
    palm = np.array(Vector(L.param("palm", [0, 0, -1])).normalized())
    v = np.cross(palm, u)
    if side == "right":
        v = -v
    bpy.context.view_layer.update()
    R.reset_pose(arm)
    rest = R.evaluated_verts(body)
    # hand vertices: those of faces in the hand slot; rim: boundary vertices of the other faces near the wrist
    hand_v = set()
    for p_ in me.polygons:
        if p_.material_index == slot:
            hand_v.update(p_.vertices)
    hand_idx = np.array(sorted(hand_v), dtype=np.int64)
    near_ = np.linalg.norm(rest[hand_idx] - wrist, axis=1) < 0.3  # this side's hand only: both hands can share one material slot
    hand_idx = hand_idx[near_]
    hand_v = set(int(i) for i in hand_idx)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.edges.ensure_lookup_table()
    rr = float(L.param("rim_radius_mm", 60)) / 1000
    zone = float(L.param("rim_zone_mm", 35)) / 1000
    s_hand_min = float(((rest[hand_idx] - wrist) @ u).min())
    rim = set()
    # a collar from hand_attach (lining_mm) closes the old boundary: the cuff's rim is then where the collar's faces (material "cuff-lining*") meet the body's own faces
    lin_slots = {i for i, m_ in enumerate(me.materials) if m_ is not None and m_.name.startswith("cuff-lining")}
    zone_ok = lambda vi: (lambda rel_: (s_hand_min - 0.003 <= float(rel_ @ u) <= s_hand_min + zone) and np.linalg.norm(rel_ - float(rel_ @ u) * u) < rr)(rest[vi] - wrist)
    if lin_slots:
        lin_v, body_v = set(), set()
        for p_ in me.polygons:
            if p_.material_index in lin_slots:
                lin_v.update(p_.vertices)
            elif p_.material_index != slot:
                body_v.update(p_.vertices)
        for vi in lin_v & body_v:
            if vi not in hand_v and zone_ok(vi):
                rim.add(vi)
    if len(rim) < 6:
        for e_ in bm.edges:
            if len(e_.link_faces) == 1 and e_.link_faces[0].material_index != slot:
                for vv in e_.verts:
                    if vv.index in hand_v:
                        continue
                    if zone_ok(vv.index):
                        rim.add(vv.index)
    bm.free()
    if len(rim) < 6:
        raise RuntimeError("found no cuff rim near the wrist (neither an open boundary nor a lining collar next to the body): is the hand joined and the old hand cut?")
    rim_idx = np.array(sorted(rim), dtype=np.int64)
    s_rim = (rest[rim_idx] - wrist) @ u
    plane = float(s_rim.mean())
    ctr_rim = rest[rim_idx].mean(0)
    rest_rad = np.linalg.norm((rest[rim_idx] - wrist) - np.outer((rest[rim_idx] - wrist) @ u, u), axis=1)
    # rest loop: consecutive neighbours by angle around the axis, for the opening measure
    ang = np.arctan2((rest[rim_idx] - ctr_rim) @ v, (rest[rim_idx] - ctr_rim) @ palm)
    order = np.argsort(ang)
    rim_sorted = rim_idx[order]
    nxt = np.roll(rim_sorted, -1)
    gap0 = np.linalg.norm(rest[rim_sorted] - rest[nxt], axis=1)
    me.calc_loop_triangles()
    hand_tris = np.array([t_.vertices[:] for t_ in me.loop_triangles if me.polygons[t_.polygon_index].material_index == slot], dtype=np.int64)
    # the cuff's outer edge: the rim vertices within 4 mm of the most forward one; the hand is sliced at its plane
    front = rim_idx[s_rim >= s_rim.max() - 0.004]
    s_front = float(((rest[front] - wrist) @ u).mean())
    ctr_v = rest[front] - wrist
    ctr2 = np.array([float((ctr_v @ v).mean()), float((ctr_v @ palm).mean())])
    hand_s = (rest[hand_idx] - wrist) @ u
    rear = hand_idx[np.argsort(hand_s)[: max(8, len(hand_idx) // 100)]]
    poses = L.param("poses") or [{"name": "rest"}] + [{"name": f"flex{'p' if a > 0 else 'm'}{abs(a)}", "flex_deg": a} for a in (40, -40)] + [{"name": f"dev{'p' if a > 0 else 'm'}{abs(a)}", "deviate_deg": a} for a in (20, -20)] + [{"name": f"twist{'p' if a > 0 else 'm'}{abs(a)}", "twist_deg": a} for a in (30, -30)]
    views = L.param("views", ["back", "thumb"])
    res = int(L.param("res", 480))
    vd = {"back": Vector((-palm).tolist()), "palm": Vector(palm.tolist()), "thumb": Vector(v.tolist()), "oblique": Vector((palm * 0.7 + v * 0.5 - u * 0.4).tolist()), "end": Vector(u.tolist()), "end_oblique": Vector((u * 0.8 + palm * 0.4 + v * 0.2).tolist())}
    out, files = {}, []
    hb_name = pre + S + "Hand"
    for P in poses:
        name = "".join(c if (c.isalnum() or c in "_-") else ("p" if c == "+" else "_") for c in str(P.get("name", "pose")))
        R.reset_pose(arm)
        # the Hand bone turns about its own head (the wrist joint)
        for key, ax in (("flex_deg", v), ("deviate_deg", palm), ("twist_deg", u)):
            a = float(P.get(key, 0) or 0)
            if a:
                R.rotate_world(arm, S + "Hand", ax.tolist(), a)
        bpy.context.view_layer.update()
        pos = R.evaluated_verts(body)
        kd = KDTree(len(hand_idx))
        for k, vi in enumerate(hand_idx):
            kd.insert(pos[vi], k)
        kd.balance()
        d = np.array([kd.find(pos[i])[2] for i in rim_idx])
        sr = (pos[rim_idx] - wrist) @ u
        behind = (pos[rear] - wrist) @ u
        gap = np.linalg.norm(pos[rim_sorted] - pos[nxt], axis=1)
        # clearance: at the cuff's front plane, the rim's radius minus the hand section's outline radius in the same direction (about the rim centre); positive = a gap between sleeve and hand, negative = the hand reaches past the rim
        hp = slice_points(pos, hand_tris, wrist, u, v, palm, s_front)
        rq = (pos[front] - wrist)
        rv, rw = rq @ v, rq @ palm
        th = np.arctan2(rw - ctr2[1], rv - ctr2[0])
        r_rim = np.hypot(rv - ctr2[0], rw - ctr2[1])
        if len(hp) >= 6:
            r_hand = outline_radius(hp, ctr2, th, bins=72)
            clr = r_rim - r_hand
            ok = ~np.isnan(clr)
            side = np.select([np.abs(th) < np.pi / 4, th >= np.pi / 4 * 1, th <= -np.pi / 4], ["thumb_side", "palm_side", "back_side"], "pinky_side")
            side = np.where(th > 3 * np.pi / 4, "pinky_side", np.where(th < -3 * np.pi / 4, "pinky_side", side))
            sides = {k: {"max": round(float(clr[ok & (side == k)].max()) * 1000, 1), "mean": round(float(clr[ok & (side == k)].mean()) * 1000, 1)} for k in ("palm_side", "back_side", "thumb_side", "pinky_side") if (ok & (side == k)).any()}
            clearance = {"max": round(float(clr[ok].max()) * 1000, 1), "mean": round(float(clr[ok].mean()) * 1000, 1), "min": round(float(clr[ok].min()) * 1000, 1), "by_side": sides, "hand_section_at_rim": section_stats(hp)}
        else:
            clearance = {"hand_section_at_rim": None, "note": "the hand does not reach the cuff's front plane"}
        pics = []
        if views:
            os.makedirs(L.ARGS["out_dir"], exist_ok=True)
            pics = render_views([body], Vector(ctr_rim.tolist()), 0.11, f"wristflex-{name}", res, {k: vd[k] for k in views})
            files += pics
        out[name] = {"pose": {k: P.get(k, 0) for k in ("flex_deg", "deviate_deg", "twist_deg")},
                     "clearance_mm": clearance, "nearest_hand_vertex_mm": {"max": round(float(d.max()) * 1000, 2), "mean": round(float(d.mean()) * 1000, 2), "p95": round(float(np.percentile(d, 95)) * 1000, 2)},
                     "hand_end_behind_rim_mm": round(float((behind.max() - sr.mean()) * 1000), 2),
                     "rim_vertex_spacing_mm": {"largest_gap": round(float(gap.max()) * 1000, 2), "largest_gap_at_rest": round(float(gap0.max()) * 1000, 2), "largest_increase": round(float((gap - gap0).max()) * 1000, 2)},
                     "pictures": [os.path.basename(p_) for p_ in pics]}
    R.reset_pose(arm)
    L.finish({"rim": {"vertices": int(len(rim_idx)), "rest_radius_mm": [round(float(rest_rad.min()) * 1000, 1), round(float(rest_rad.max()) * 1000, 1)],
                      "along_axis_mm": [round(float(s_rim.min()) * 1000, 1), round(float(s_rim.max()) * 1000, 1)]}, "hand_vertices": int(len(hand_idx)), "poses": out}, files=files)


L.run(main)
