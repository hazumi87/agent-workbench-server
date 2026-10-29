"""scene_inspect — list what is in the job's scene, read only: objects with their transforms, the rig's rest bones, how each mesh is bound, mesh topology, UV layers, materials and images, and the animation data. Changes nothing, saves no checkpoint.

params:
  objects      names or globs to report (default every object); a list that matches nothing is an error
  bones        true (default): per bone parent, rest head / tail / roll (armature space: the armature object's own units, which carry its scale and rotation) and head_world / tail_world (metres), length_mm in the world, deform flag, matrix_local (the bind, rest, armature space)
  topology     true (default): per mesh the connected components (vertices, triangles, bounds each), loose vertices, non-manifold edges
  uv           true (default): per mesh each UV layer: islands, how many UV points lie outside 0..1, the UDIM tiles used
  materials    true (default): materials with their image textures; all images with size, colour space, packed or file path
  animation    true (default): actions (frame range, curves, users, fake user), NLA tracks, the current frame and pose: per bone the largest deviation of the current pose from rest
  show         sections to put in the report's own `summary.detail` (the part a runner prints): any of "objects", "bones", "matrices" (bones with matrix_local), "meshes" (bind, topology, UV), "materials", "images", "animation", "findings".
               Default none (the summary stays short). Over 60000 characters the detail is refused with its size: ask for fewer sections or use `objects` to narrow it.
  name         file stem of the full JSON written to out/ (default scene_inspect)
Returns: summary (short; plus `detail` for the sections named in `show`). The full inspection is in out/<name>.json; the report holds the same, with the bones list cut to 60 entries and the component lists to 12 per mesh (`truncated` says what).
Plus summary lines: objects by type, triangles of the deforming mesh(es), armatures with bone counts, meshes bound to which armature, actions that animate the armature, and `findings`: plain observations
(a mesh that is not skinned, a mesh in the scene that is not part of the body, an animated rig not at rest, a bound mesh whose bounds sit outside the rig's, unapplied scale on the armature...). Observations, not verdicts.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def r(x, n=5):
    return round(float(x), n)


def vec(v, n=5):
    return [r(c, n) for c in v]


def mat(m, n=5):
    return [[r(c, n) for c in row] for row in m]


def obj_info(o):
    d = {"name": o.name, "type": o.type, "data": o.data.name if o.data else None, "parent": o.parent.name if o.parent else None, "parent_type": o.parent_type if o.parent else None,
         "location": vec(o.location), "rotation_euler_deg": [r(np.degrees(a), 3) for a in o.rotation_euler], "rotation_mode": o.rotation_mode, "scale": vec(o.scale),
         "matrix_world": mat(o.matrix_world), "dimensions": vec(o.dimensions),
         "visible": {"hide_viewport": o.hide_viewport, "hide_render": o.hide_render, "hidden_in_view_layer": o.hide_get() if o.name in bpy.context.view_layer.objects else None},
         "collections": [c.name for c in o.users_collection]}
    if o.parent:
        d["matrix_parent_inverse"] = mat(o.matrix_parent_inverse)
    d["modifiers"] = [{"name": m.name, "type": m.type, **({"object": m.object.name if m.object else None, "use_vertex_groups": m.use_vertex_groups, "use_deform_preserve_volume": m.use_deform_preserve_volume} if m.type == "ARMATURE" else {})} for m in o.modifiers]
    ad = o.animation_data
    if ad:
        d["animation"] = {"action": ad.action.name if ad.action else None, "nla_tracks": [{"name": t.name, "mute": t.mute, "strips": [{"name": s.name, "action": s.action.name if s.action else None, "start": s.frame_start, "end": s.frame_end} for s in t.strips]} for t in ad.nla_tracks]}
    if o.type == "MESH":
        d["vertex_groups"] = len(o.vertex_groups)
        d["shape_keys"] = [k.name for k in o.data.shape_keys.key_blocks] if o.data.shape_keys else []
    return d


def world_bounds(o):
    n = len(o.data.vertices)
    co = np.empty(n * 3)
    o.data.vertices.foreach_get("co", co)
    V = co.reshape(-1, 3)
    M = np.array(o.matrix_world)
    W = V @ M[:3, :3].T + M[:3, 3]
    return W.min(0), W.max(0)


def topology(o, cap):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    seen, comps = set(), []
    for v0 in bm.verts:
        if v0.index in seen:
            continue
        stack, vs = [v0], []
        seen.add(v0.index)
        while stack:
            v = stack.pop()
            vs.append(v)
            for e in v.link_edges:
                w = e.other_vert(v)
                if w.index not in seen:
                    seen.add(w.index)
                    stack.append(w)
        P = np.array([v.co[:] for v in vs])
        faces = {f.index for v in vs for f in v.link_faces}
        tris = sum(len(f.verts) - 2 for f in bm.faces if f.index in faces) if len(faces) < 4000 else None
        comps.append({"vertices": len(vs), "faces": len(faces), "tris": tris, "min": vec(P.min(0)), "max": vec(P.max(0))})
    nm = sum(1 for e in bm.edges if not e.is_manifold)
    loose = sum(1 for v in bm.verts if not v.link_edges)
    bm.free()
    comps.sort(key=lambda c: -c["vertices"])
    return {"components": len(comps), "loose_vertices": loose, "non_manifold_edges": nm, "list": comps[:cap]}, len(comps) > cap


def uv_info(o):
    me = o.data
    out = []
    for lay in me.uv_layers:
        n = len(me.loops)
        co = np.empty(n * 2)
        lay.data.foreach_get("uv", co)
        U = co.reshape(-1, 2)
        outside = int(((U < -1e-4) | (U > 1 + 1e-4)).any(1).sum())
        tiles = sorted({(int(np.floor(u)), int(np.floor(v))) for u, v in U[:: max(1, n // 20000)]})
        # islands: union-find over faces sharing a vertex AND a uv coordinate
        parent = list(range(len(me.polygons)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        seen = {}
        for p in me.polygons:
            for li in p.loop_indices:
                key = (me.loops[li].vertex_index, round(U[li][0], 4), round(U[li][1], 4))
                if key in seen:
                    parent[find(p.index)] = find(seen[key])
                else:
                    seen[key] = p.index
        out.append({"name": lay.name, "active": lay.active, "active_render": lay.active_render, "islands": len({find(i) for i in range(len(parent))}),
                    "points_outside_0_1": outside, "udim_tiles": [list(t) for t in tiles][:12]})
    return out


def mat_info():
    mats = []
    for m in bpy.data.materials:
        imgs = []
        if m.use_nodes:
            for nd in m.node_tree.nodes:
                if nd.type == "TEX_IMAGE" and nd.image:
                    imgs.append({"node": nd.name, "image": nd.image.name, "colorspace": nd.image.colorspace_settings.name})
        mats.append({"name": m.name, "users": m.users, "images": imgs})
    ims = [{"name": i.name, "size": list(i.size), "colorspace": i.colorspace_settings.name, "packed": bool(i.packed_file), "file": i.filepath or None, "users": i.users} for i in bpy.data.images if i.type == "IMAGE"]
    return mats, ims


def anim_info(arm, scn):
    acts = []
    for a in bpy.data.actions:
        acts.append({"name": a.name, "frame_range": [r(a.frame_range[0], 2), r(a.frame_range[1], 2)], "curves": len(a.fcurves), "users": a.users, "fake_user": a.use_fake_user,
                     "bones": len({fc.data_path.split('"')[1] for fc in a.fcurves if fc.data_path.startswith("pose.bones[")})})
    dev = None
    if arm is not None:
        worst = []
        for pb in arm.pose.bones:
            q = pb.rotation_quaternion if pb.rotation_mode == "QUATERNION" else pb.rotation_euler.to_quaternion()
            rot = np.degrees(2 * np.arccos(min(1.0, abs(q.w))))
            loc = pb.location.length * 1000
            sc = max(abs(c - 1) for c in pb.scale)
            if rot > 0.01 or loc > 0.01 or sc > 1e-5:
                worst.append({"bone": pb.name, "rot_deg": r(rot, 2), "loc_mm": r(loc, 2), "scale_dev": r(sc, 4)})
        worst.sort(key=lambda w: -(w["rot_deg"] + w["loc_mm"]))
        dev = {"bones_off_rest": len(worst), "worst": worst[:8]}
    return {"frame_current": scn.frame_current, "frame_range": [scn.frame_start, scn.frame_end], "actions": acts, "pose_vs_rest": dev}


def main():
    scn = bpy.context.scene
    want = L.param("objects")
    import fnmatch as _fn
    if isinstance(want, str):
        want = [want]
    objs = [o for o in scn.objects if not want or any(o.name == w or _fn.fnmatchcase(o.name, w) for w in want)]
    if want and not objs:
        raise RuntimeError(f"objects: nothing in the scene matches {want} (names or globs such as '*Heater*'; names are case-sensitive)")
    full = {"objects": [obj_info(o) for o in objs], "truncated": []}
    arms = [o for o in objs if o.type == "ARMATURE"]
    meshes = [o for o in objs if o.type == "MESH"]
    cap_b = 60
    if L.param("bones", True):
        full["armatures"] = []
        for a in arms:
            bl = []
            for b in a.data.bones:
                h, t = b.head_local, b.tail_local
                # roll: angle of the bone's z axis about its y axis relative to the default for that direction
                bl.append({"name": b.name, "parent": b.parent.name if b.parent else None, "head": vec(h), "tail": vec(t), "roll_deg": r(np.degrees(b.AxisRollFromMatrix(b.matrix.to_3x3())[1]), 3),
                           "length_mm": r((a.matrix_world @ t - a.matrix_world @ h).length * 1000, 2), "head_world": vec(a.matrix_world @ h), "tail_world": vec(a.matrix_world @ t), "deform": b.use_deform, "matrix_local": mat(b.matrix_local)})
            full["armatures"].append({"object": a.name, "pose_position": a.data.pose_position, "display_type": a.data.display_type, "bones": bl, "roots": [b["name"] for b in bl if b["parent"] is None],
                                      "non_deform": [b["name"] for b in bl if not b["deform"]]})
    comp_cap = 12
    full["meshes"] = []
    for o in meshes:
        me = o.data
        mn, mx = world_bounds(o)
        d = {"object": o.name, "vertices": len(me.vertices), "tris": sum(len(p.vertices) - 2 for p in me.polygons), "world_min": vec(mn), "world_max": vec(mx), "materials": [m.name if m else None for m in me.materials],
             "color_attributes": [c.name for c in me.color_attributes]}
        arm_mod = next((m for m in o.modifiers if m.type == "ARMATURE"), None)
        names = {g.name for g in o.vertex_groups}
        d["bind"] = {"armature_modifier": arm_mod.object.name if arm_mod and arm_mod.object else None, "parent": o.parent.name if o.parent else None, "parent_type": o.parent_type if o.parent else None,
                     "matrix_parent_inverse": mat(o.matrix_parent_inverse) if o.parent else None, "vertex_groups": len(names)}
        if arm_mod and arm_mod.object and arm_mod.object.type == "ARMATURE":
            bn = {b.name for b in arm_mod.object.data.bones}
            d["bind"]["groups_matching_bones"] = len(names & bn)
            d["bind"]["groups_without_bone"] = sorted(names - bn)[:10]
            d["bind"]["deform_bones_without_group"] = sorted(b.name for b in arm_mod.object.data.bones if b.use_deform and b.name not in names)[:10]
        if L.param("topology", True):
            t, cut = topology(o, comp_cap)
            d["topology"] = t
            if cut:
                full["truncated"].append(f"{o.name}: components cut to {comp_cap} of {t['components']}")
        if L.param("uv", True):
            d["uv"] = uv_info(o)
        full["meshes"].append(d)
    if L.param("materials", True):
        full["materials"], full["images"] = mat_info()
    arm0 = arms[0] if arms else None
    if L.param("animation", True):
        full["animation"] = anim_info(arm0, scn)

    # plain observations
    finds = []
    for a in arms:
        if any(abs(c - 1) > 1e-6 for c in a.scale):
            finds.append(f"armature {a.name} carries scale {vec(a.scale, 4)} (not applied): world bone positions include it")
        if a.animation_data and (a.animation_data.action or a.animation_data.nla_tracks):
            finds.append(f"armature {a.name} is animated (action {a.animation_data.action.name if a.animation_data.action else None}, {len(a.animation_data.nla_tracks)} NLA tracks)")
    for m in full["meshes"]:
        if m["bind"]["vertex_groups"] == 0 and m["bind"]["armature_modifier"] is None:
            finds.append(f"mesh {m['object']} ({m['tris']} tris) is not skinned: no vertex groups, no armature modifier")
        if m["topology"]["components"] > 1 if "topology" in m else False:
            finds.append(f"mesh {m['object']} has {m['topology']['components']} connected components")
    skinned = [m for m in full["meshes"] if m["bind"]["armature_modifier"]]
    unskinned = [m for m in full["meshes"] if not m["bind"]["armature_modifier"]]
    if skinned and unskinned:
        finds.append("scene holds skinned and unskinned meshes: " + ", ".join(f"{m['object']} ({m['tris']} tris)" for m in unskinned) + " are outside the skin")
    if skinned and unskinned:
        lo = np.min([m["world_min"] for m in skinned], 0)
        hi = np.max([m["world_max"] for m in skinned], 0)
        for m in unskinned:
            if (np.array(m["world_min"]) < lo - 1e-4).any() or (np.array(m["world_max"]) > hi + 1e-4).any():
                finds.append(f"unskinned mesh {m['object']} extends beyond the skinned mesh's bounds ({vec(lo, 3)} .. {vec(hi, 3)}): it widens the scene bounds")
    dev = full.get("animation", {}).get("pose_vs_rest")
    if dev and dev["bones_off_rest"]:
        finds.append(f"the current pose of {dev['bones_off_rest']} bone(s) differs from rest (worst {dev['worst'][0]['bone']}: {dev['worst'][0]['rot_deg']} deg, {dev['worst'][0]['loc_mm']} mm)")
    full["findings"] = finds
    full["summary"] = {"objects": {t: sum(1 for o in objs if o.type == t) for t in sorted({o.type for o in objs})}, "skinned_tris": sum(m["tris"] for m in skinned),
                       "armatures": {a["object"]: len(a["bones"]) for a in full.get("armatures", [])}, "frame": scn.frame_current}

    out_name = L.param("name", "scene_inspect")
    os.makedirs(L.ARGS["out_dir"], exist_ok=True)
    with open(os.path.join(L.ARGS["out_dir"], out_name + ".json"), "w", encoding="utf-8") as f:
        json.dump(full, f, indent=1)
    rep = json.loads(json.dumps(full))
    for a in rep.get("armatures", []):
        if len(a["bones"]) > cap_b:
            rep["truncated"].append(f"{a['object']}: bones cut to {cap_b} of {len(a['bones'])}")
            a["bones"] = a["bones"][:cap_b]
    summary = dict(full["summary"])
    show = L.param("show") or []
    if show:
        det = {}
        for s in show:
            if s == "bones":
                det["bones"] = [{"object": a["object"], "pose_position": a["pose_position"], "roots": a["roots"], "non_deform": a["non_deform"],
                                 "bones": [{k: v for k, v in b.items() if k != "matrix_local"} for b in a["bones"]]} for a in full.get("armatures", [])]
            elif s == "matrices":
                det["matrices"] = [{"object": a["object"], "bones": [{"name": b["name"], "matrix_local": b["matrix_local"]} for b in a["bones"]]} for a in full.get("armatures", [])]
            elif s in ("objects", "meshes", "materials", "images", "animation", "findings"):
                det[s] = full.get(s)
            else:
                raise RuntimeError(f"show: unknown section {s}")
        n = len(json.dumps(det))
        if n > 60000:
            raise RuntimeError(f"detail is {n} characters (limit 60000): ask for fewer sections in `show`, or narrow with `objects`")
        summary["detail"], summary["detail_chars"] = det, n
    L.finish(summary, save=False, file=out_name + ".json", **{k: v for k, v in rep.items() if k != "summary"})


L.run(main)
