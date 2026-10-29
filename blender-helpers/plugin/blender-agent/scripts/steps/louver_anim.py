"""louver_anim — named, reversible OPEN and CLOSE animation clips for the blades of one or more bays, nothing else moves. Saves a checkpoint (not with dry_run).

For each bay `<bay>` and each of its blades, two Blender actions are made and put on the blade as NLA tracks named `<bay>.open` and `<bay>.close` (the close clip is the open clip run backwards, so it ends exactly where the blade started). The blades keep their rest pose when no clip plays. `export_scene` writes each track as one glTF animation with the track's name (`bay_1.open`, `bay_1.close`) holding the rotation channels of that bay's blades only.
Needs each blade's pivot at its centre: run scene_tree `origins` first (the report warns when a blade's origin is not at its bounding-box centre). The blades turn about their own LONGEST axis (axis "auto") or "x" | "y" | "z" (the object's local axis; blockout objects have no rotation, so that is the world axis).
params:
  bays        [{"name": "bay_1", "blades": "Blade_*" (a glob) | ["Blade_01", ...], "open_deg": 90 (this bay only), "stagger_frames": 0}]
  open_deg    degrees the blades turn when open, from their rest pose (default 90; negative turns the other way)
  axis        "auto" (default) | "x" | "y" | "z"
  frames      length of one blade's turn in frames (default 30); fps  scene frame rate (default 30)
  stagger_frames  each next blade (in name order) starts this many frames later, a ripple (default 0 = all together)
  replace     true: rebuild clips this verb made for these bays (default false: an existing clip is left alone and reported)
  views       pictures of the first bay closed and open: "iso" | "front" | "side" | "top" (default ["iso"]); res px (default 640)
  dry_run     true: nothing is made; the report lists blades, axes and clip lengths
Returns: per bay: blades, axis per blade, clips (name, frames, seconds), a check (each clip evaluated at its first and last frame: every blade's turn in degrees, and the number of objects OUTSIDE the bay that moved: must be 0), warnings (pivot not at the centre, no match), pictures.
"""
import fnmatch
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import _handview as HV  # noqa: E402

AXI = {"x": 0, "y": 1, "z": 2}


def blades_of(spec):
    if isinstance(spec, list):
        return [bpy.data.objects[n] for n in spec if n in bpy.data.objects and bpy.data.objects[n].type == "MESH"]
    return sorted([o for o in bpy.data.objects if o.type == "MESH" and fnmatch.fnmatchcase(o.name, spec)], key=lambda o: o.name)


def longest_axis(o):
    ext = [max(c[i] for c in o.bound_box) - min(c[i] for c in o.bound_box) for i in range(3)]
    return ext.index(max(ext))


def centre_off_mm(o):
    c = sum((Vector(b) for b in o.bound_box), Vector()) / 8.0
    return c.length * 1000


def main():
    dry = bool(L.param("dry_run", False))
    replace = bool(L.param("replace", False))
    scn = bpy.context.scene
    frames = int(L.param("frames", 30))
    fps = int(L.param("fps", 30))
    stag = int(L.param("stagger_frames", 0))
    open_deg = float(L.param("open_deg", 90))
    axis = L.param("axis", "auto")
    if axis not in ("auto", "x", "y", "z"):
        raise RuntimeError('axis must be "auto", "x", "y" or "z"')
    bays = L.param("bays") or []
    if not bays:
        raise RuntimeError("give `bays`")
    rep = {"bays": [], "warnings": []}
    allb = set()
    plan = []
    for b in bays:
        bl = blades_of(b["blades"])
        name = b["name"]
        if not bl:
            rep["warnings"].append(f"{name}: no blades matched {b['blades']}")
            continue
        if allb & {o.name for o in bl}:
            raise RuntimeError(f"{name}: a blade is already in another bay of this call")
        allb |= {o.name for o in bl}
        od = float(b.get("open_deg", open_deg))
        sg = int(b.get("stagger_frames", stag))
        clips = [f"{name}.open", f"{name}.close"]
        exist = [o.name for o in bl if o.animation_data and any(t.name in clips for t in o.animation_data.nla_tracks)]
        row = {"name": name, "blades": len(bl), "open_deg": od, "stagger_frames": sg, "frames_per_blade": frames, "clip_frames": frames + sg * (len(bl) - 1), "clip_seconds": round((frames + sg * (len(bl) - 1)) / fps, 3), "clips": clips, "axis": {}}
        for o in bl:
            ai = longest_axis(o) if axis == "auto" else AXI[axis]
            row["axis"][o.name] = "XYZ"[ai]
            if centre_off_mm(o) > 1.0:
                rep["warnings"].append(f"{o.name}: its origin is {centre_off_mm(o):.1f} mm from the middle of its bounding box: run scene_tree origins first or it will swing about that point")
        if exist and not replace:
            row["existing"] = True
            rep["warnings"].append(f"{name}: clips already exist on {len(exist)} blades; left alone (replace: true to rebuild)")
        plan.append((b, bl, row, od, sg, clips, bool(exist) and not replace))
        rep["bays"].append(row)
    if not dry:
        scn.render.fps = fps
        for b, bl, row, od, sg, clips, skip in plan:
            if skip:
                continue
            for i, o in enumerate(bl):
                ai = AXI.get(row["axis"][o.name].lower())
                a0 = o.rotation_euler[ai]
                a1 = a0 + math.radians(od)
                ad = o.animation_data_create()
                for t in [t for t in ad.nla_tracks if t.name in clips]:
                    for st in list(t.strips):
                        if st.action is not None and st.action.users <= 1:
                            bpy.data.actions.remove(st.action)
                    ad.nla_tracks.remove(t)
                start = 1 + i * sg
                bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
                for cname, (x0, x1) in zip(clips, ((a0, a1), (a1, a0))):
                    ad.action = None
                    o.rotation_euler[ai] = x0
                    if start > 1:
                        o.keyframe_insert("rotation_euler", index=ai, frame=1)
                    o.keyframe_insert("rotation_euler", index=ai, frame=start)
                    o.rotation_euler[ai] = x1
                    o.keyframe_insert("rotation_euler", index=ai, frame=start + frames)
                    act = ad.action
                    act.name = f"{cname}|{o.name}"
                    act["louver_anim"] = True
                    tr = ad.nla_tracks.new()
                    tr.name = cname
                    st = tr.strips.new(act.name, 1, act)
                    st.extrapolation = "NOTHING"
                    tr.mute = True  # muted in the scene so the blades stay at rest; export_scene still writes each track as its own clip
                    ad.action = None
                o.rotation_euler[ai] = a0
                ad.action = None
    rest_pose = {o.name: tuple(o.rotation_euler) for b, bl, row, od, sg, clips, skip in plan for o in bl}  # restored after the check and the pictures: evaluating a clip leaves the blade turned
    rest_hide = {o.name: o.hide_render for o in scn.objects}
    # check: evaluate each clip at its first and last frame and compare every object's matrix
    files = []
    if not dry and plan:
        objs = list(scn.objects)
        for b, bl, row, od, sg, clips, skip in plan:
            if skip:
                continue
            res = {}
            for cname in clips:
                snaps = {}
                for fr in (1, row["clip_frames"] + 1):
                    for o in bl:
                        tr = next((t for t in o.animation_data.nla_tracks if t.name == cname), None)
                        o.animation_data.action = tr.strips[0].action if tr else None
                    scn.frame_set(fr)
                    snaps[fr] = {o.name: o.matrix_world.copy() for o in objs}
                    snaps[("rot", fr)] = {o.name: [math.degrees(x) for x in o.rotation_euler] for o in bl}
                for o in bl:
                    o.animation_data.action = None
                f0, f1 = 1, row["clip_frames"] + 1
                turn = {o.name: round(max(abs(a - b_) for a, b_ in zip(snaps[("rot", f1)][o.name], snaps[("rot", f0)][o.name])), 3) for o in bl}
                outside = [n for n in snaps[f0] if n not in {o.name for o in bl} and (snaps[f0][n].to_translation() - snaps[f1][n].to_translation()).length + sum(abs(snaps[f0][n][i][j] - snaps[f1][n][i][j]) for i in range(3) for j in range(3)) > 1e-9]
                res[cname] = {"blade_turn_deg_min": min(turn.values()), "blade_turn_deg_max": max(turn.values()), "objects_outside_the_bay_that_moved": len(outside)}
            scn.frame_set(1)
            row["check"] = res
    if not dry and plan and L.param("views", ["iso"]):
        b, bl, row, od, sg, clips, skip = plan[0]
        if not skip:
            bpy.context.view_layer.update()
            pts = [o.matrix_world @ Vector(c) for o in bl for c in o.bound_box]
            lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
            hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
            ctr, size = (lo + hi) / 2, max((hi - lo).length * 1.1, 0.5)
            dirs = {"iso": (0.6, -0.8, 0.5), "front": (0, -1, 0.05), "side": (1, 0, 0.05), "top": (0, 0, 1)}
            sel = {v: dirs[v] for v in L.param("views", ["iso"]) if v in dirs}
            for state, cname in (("closed", clips[0]), ("open", clips[0])):
                for o in bl:
                    tr = next(t for t in o.animation_data.nla_tracks if t.name == cname)
                    o.animation_data.action = tr.strips[0].action
                scn.frame_set(1 if state == "closed" else row["clip_frames"] + 1)
                bpy.context.view_layer.update()
                files += HV.render_views(bl, ctr, size, f"louver-{state}", res=int(L.param("res", 640)), dirs=sel)
            for o in bl:
                o.animation_data.action = None
            scn.frame_set(1)
    if not dry:
        for b, bl, row, od, sg, clips, skip in plan:
            for o in bl:
                if o.animation_data:
                    o.animation_data.action = None
                o.rotation_euler = rest_pose[o.name]
        for o in scn.objects:
            if o.name in rest_hide:
                o.hide_render = rest_hide[o.name]
        scn.frame_set(1)
        bpy.context.view_layer.update()
    L.finish({"dry_run": dry, "bays": len(rep["bays"]), "warnings": len(rep["warnings"])}, save=not dry, files=files, **rep, pictures=[os.path.basename(f) for f in files])


L.run(main)
