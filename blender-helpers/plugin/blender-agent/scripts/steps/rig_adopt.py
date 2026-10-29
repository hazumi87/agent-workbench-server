"""rig_adopt — take a rig that came in with its own animation (a demo clip, NLA tracks) and put it at REST, so the rig_* verbs measure the mesh and not the clip. Saves a checkpoint.

The body's geometry, the bones' rest joints (heads, tails, rolls) and the skin weights are never changed: they are measured before and after and the report says whether anything drifted.
What it does:
  - animation: every action assigned to an object, an armature, a mesh or its shape keys, a material or the scene is unassigned, and every NLA track on them is removed. The actions stay in the file (given a fake user) so nothing
    is destroyed: `actions_kept` names them. Re-assign one with rig_clip.
  - pose: every bone is put at identity (no location, no rotation, scale 1) and the frame is set to `frame`. (Rotation mode is set to quaternion, as the other rig verbs expect.)
  - helpers: a mesh in the scene that is not skinned to the armature (a stray sphere, a guide) is moved to a hidden collection `Excluded_helpers` and hidden in the viewport and render, so it is not in the body's bounds,
    the views or the export (export_rig / export_bind export the armature and `body` only). The object is not deleted.
  - tails (`tails`): "sensible" (default) shortens or lengthens a bone's tail ALONG ITS OWN DIRECTION to the distance of its nearest-aligned child's head (a leaf bone: half its parent's length, never longer than it was), so a bone that reaches
    far past its child is drawn sensibly. Heads, directions and rolls do not change, so every bone's rest matrix (matrix_local, the bind) and the skin weights are the same: `drift.bone_rotation_max_abs` (about 1e-7 = float rounding) proves it. "keep" leaves tails as they are.
params:
  armature  the rig object (default "rig")
  body      the skinned mesh (default "body")
  tails     "sensible" (default) or "keep" (see above)
  frame     the frame to leave the scene on (default 1)
  helpers   "auto" (default): every mesh that has no armature modifier and no vertex groups; or a list of object names; or [] for none
  dry_run   true = measure and report, change nothing, save nothing
Returns: before / after: bones off rest (count and worst rotation deg, location mm), evaluated body vs its stored geometry (max move mm), animation items found and cleared; drift: bone heads, bone_rotation_max_abs (max change of any bone's rest rotation matrix: 0 = no bone turned), body vertices (max mm), `tails_changed` (bone, world length mm before and after, direction change deg),
body vertices (max mm), weights (max change; a SHA-256 of the rounded weights before and after); helpers moved; actions_kept; rest_fit: per deform bone how far the bone's segment is from the centre of the vertices it owns
(weight >= 0.5), worst 6; scene bounds before and after (skinned body only / all objects).
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402


def weights_array(body):
    me = body.data
    n = len(me.vertices)
    W = np.zeros((n, len(body.vertex_groups)), dtype=np.float32)
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return W


def rest_snapshot(arm):
    d = {}
    for b in arm.data.bones:
        d[b.name] = (np.array(b.head_local), np.array(b.tail_local), np.array(b.matrix_local))
    return d


def stored_verts(body):
    co = np.empty(len(body.data.vertices) * 3, dtype=np.float32)
    body.data.vertices.foreach_get("co", co)
    m = np.array(body.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def pose_state(arm):
    worst_rot, worst_loc, n = 0.0, 0.0, 0
    for pb in arm.pose.bones:
        q = pb.rotation_quaternion if pb.rotation_mode == "QUATERNION" else pb.rotation_euler.to_quaternion()
        rot = float(np.degrees(2 * np.arccos(min(1.0, abs(q.w)))))
        loc = pb.location.length * 1000
        if rot > 0.01 or loc > 0.01 or max(abs(c - 1) for c in pb.scale) > 1e-5:
            n += 1
        worst_rot, worst_loc = max(worst_rot, rot), max(worst_loc, loc)
    return {"bones_off_rest": n, "worst_rot_deg": round(worst_rot, 2), "worst_loc_mm": round(worst_loc, 2)}


def animated_things():
    """every datablock holding animation: [(kind, owner name, holder with animation_data)]"""
    out = []
    pools = [("object", bpy.data.objects), ("armature", bpy.data.armatures), ("mesh", bpy.data.meshes), ("shape_keys", bpy.data.shape_keys), ("material", bpy.data.materials),
             ("scene", bpy.data.scenes), ("world", bpy.data.worlds), ("camera", bpy.data.cameras), ("light", bpy.data.lights)]
    for kind, pool in pools:
        for x in pool:
            ad = getattr(x, "animation_data", None)
            if ad and (ad.action or len(ad.nla_tracks) or len(ad.drivers)):
                out.append((kind, x.name, x))
    return out


def bounds(objs):
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for o in objs:
        V = stored_verts(o) if o.type == "MESH" else None
        if V is None or not len(V):
            continue
        lo, hi = np.minimum(lo, V.min(0)), np.maximum(hi, V.max(0))
    return [round(float(x), 4) for x in lo], [round(float(x), 4) for x in hi]


def rest_fit(arm, body, W):
    names = [g.name for g in body.vertex_groups]
    V = stored_verts(body)
    mw = np.array(arm.matrix_world)
    res = []
    for b in arm.data.bones:
        if not b.use_deform or b.name not in names:
            continue
        sel = W[:, names.index(b.name)] >= 0.5
        if sel.sum() < 5:
            continue
        c = V[sel].mean(0)
        h = mw[:3, :3] @ np.array(b.head_local) + mw[:3, 3]
        t = mw[:3, :3] @ np.array(b.tail_local) + mw[:3, 3]
        d = t - h
        s = float(np.clip(((c - h) @ d) / max(d @ d, 1e-12), 0, 1))
        res.append({"bone": b.name, "owned_vertices": int(sel.sum()), "centre_to_segment_mm": round(float(np.linalg.norm(c - (h + d * s)) * 1000), 1)})
    res.sort(key=lambda r: -r["centre_to_segment_mm"])
    return res


def sensible_tails(arm):
    """tails along their own direction to the nearest-aligned child's head (a leaf: half its parent, at most as long as it was). Returns the list of changes."""
    sc = arm.matrix_world.to_scale().x
    cur = bpy.context.view_layer.objects.active
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    out = []
    try:
        eb = arm.data.edit_bones
        order = []
        stack = [b for b in eb if b.parent is None]
        while stack:
            b = stack.pop(0)
            order.append(b)
            stack += list(b.children)
        for b in order:
            d = b.tail - b.head
            if d.length < 1e-9:
                continue
            dn = d.normalized()
            old = b.length
            new = None
            if b.children:
                best = max(b.children, key=lambda c: dn.dot((c.head - b.head).normalized()) if (c.head - b.head).length > 1e-9 else -2)
                proj = dn.dot(best.head - b.head)
                if proj > 1e-6:
                    new = proj
            elif b.parent is not None:
                new = min(old, 0.5 * b.parent.length)
            if new is None or abs(new - old) <= 0.02 * old:
                continue
            b.tail = b.head + dn * new
            out.append({"bone": b.name, "length_mm_before": round(old * sc * 1000, 1), "length_mm_after": round(new * sc * 1000, 1),
                        "direction_change_deg": round(float(np.degrees(dn.angle((b.tail - b.head).normalized(), 0))), 4)})
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.context.view_layer.objects.active = cur
    return out


def main():
    arm = bpy.data.objects[L.param("armature", "rig")]
    body = bpy.data.objects[L.param("body", "body")]
    if arm.type != "ARMATURE" or body.type != "MESH":
        raise RuntimeError("armature must be an armature object and body a mesh")
    dry = bool(L.param("dry_run", False))
    scn = bpy.context.scene
    helpers_p = L.param("helpers", "auto")
    skinned = {o.name for o in bpy.data.objects if o.type == "MESH" and (any(m.type == "ARMATURE" for m in o.modifiers) or len(o.vertex_groups))}
    if helpers_p == "auto":
        helpers = [o for o in scn.objects if o.type == "MESH" and o.name not in skinned and o is not body]
    else:
        helpers = [bpy.data.objects[n] for n in (helpers_p or [])]
        for h in helpers:
            if h is body:
                raise RuntimeError("the body cannot be a helper")

    # ---- before
    snap0 = rest_snapshot(arm)
    V0 = stored_verts(body)
    W0 = weights_array(body)
    wh0 = hashlib.sha256(np.round(W0, 5).tobytes()).hexdigest()
    ev0 = R.evaluated_verts(body)
    before = {"pose": pose_state(arm), "evaluated_vs_stored_body_max_move_mm": round(float(np.linalg.norm(ev0 - V0, axis=1).max() * 1000), 1), "frame": scn.frame_current,
              "scene_bounds_all_objects": bounds([o for o in scn.objects if o.type == "MESH"]), "body_bounds": bounds([body])}
    found = [{"kind": k, "name": n, "action": x.animation_data.action.name if x.animation_data.action else None, "nla_tracks": len(x.animation_data.nla_tracks), "drivers": len(x.animation_data.drivers)}
             for k, n, x in animated_things()]
    kept = sorted({a.name for a in bpy.data.actions})

    tails_changed = []
    if not dry:
        # animation: unassign and drop the tracks; the actions stay with a fake user
        for a in bpy.data.actions:
            a.use_fake_user = True
        for k, n, x in animated_things():
            ad = x.animation_data
            if ad.action:
                ad.action = None
            for t in list(ad.nla_tracks):
                ad.nla_tracks.remove(t)
        scn.frame_set(int(L.param("frame", 1)))
        R.reset_pose(arm)
        if helpers:
            col = bpy.data.collections.get("Excluded_helpers") or bpy.data.collections.new("Excluded_helpers")
            if col.name not in scn.collection.children:
                scn.collection.children.link(col)
            for h in helpers:
                for c in list(h.users_collection):
                    c.objects.unlink(h)
                col.objects.link(h)
                h.hide_viewport = True
                h.hide_render = True
                h["export"] = False
            col.hide_viewport = True
            col.hide_render = True
        bpy.context.view_layer.update()
        if L.param("tails", "sensible") == "sensible":
            tails_changed = sensible_tails(arm)

    # ---- after
    snap1 = rest_snapshot(arm)
    V1 = stored_verts(body)
    W1 = weights_array(body)
    wh1 = hashlib.sha256(np.round(W1, 5).tobytes()).hexdigest()
    ev1 = R.evaluated_verts(body)
    after = {"pose": pose_state(arm), "evaluated_vs_stored_body_max_move_mm": round(float(np.linalg.norm(ev1 - V1, axis=1).max() * 1000), 1), "frame": scn.frame_current,
             "scene_bounds_skinned_body_only": bounds([body]), "animation_left": [(k, n) for k, n, _ in animated_things()]}
    hd = max(float(np.linalg.norm(snap1[k][0] - snap0[k][0])) for k in snap0) * 1000
    td = max(float(np.linalg.norm(snap1[k][1] - snap0[k][1])) for k in snap0) * 1000
    md = max(float(np.abs(snap1[k][2][:3, :3] - snap0[k][2][:3, :3]).max()) for k in snap0)  # the rotation part: 0 = no bone turned (the origin is the head, measured above)
    drift = {"bone_heads_max_mm": round(hd, 4), "bone_tails_moved_max_mm": round(td, 4), "tails_changed": tails_changed, "bone_rotation_max_abs": round(md, 7), "body_vertices_max_mm": round(float(np.linalg.norm(V1 - V0, axis=1).max() * 1000), 4),
             "weights_max_change": round(float(np.abs(W1 - W0).max()), 6), "weights_sha256_before": wh0[:16], "weights_sha256_after": wh1[:16], "weights_same": wh0 == wh1,
             "bones": len(snap0), "vertices": len(V0)}
    summary = {"dry_run": dry, "animation_found": found, "actions_kept": kept if not dry else kept, "helpers": [h.name for h in helpers], "before": before, "after": after, "drift": drift,
               "rest_fit_worst": rest_fit(arm, body, W1)[:6]}
    L.finish(summary, save=not dry)


L.run(main)
