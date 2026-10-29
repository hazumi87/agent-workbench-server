"""rig_view — look at the rig: bones with labels and axes, and weight heat maps painted on the skin. Saves nothing.

The skin is drawn see-through (so the skeleton shows inside it) or opaque; bones are solid shapes (left blue, right red, centre green, the ones you pick yellow); labels are text that always faces the camera.
A heat map paints one bone's weight on the skin (blue = 0, green = 0.5, red = 1), or how many bones influence each vertex (1 blue … 5 or more red), or how far each vertex's total weight is from 1.
Same look as the watch (Workbench, no shadows, standard colours). Pictures go to out/ as rigview-<name>-<view>.png; post them with `post`.

params:
  views     list of "front", "back", "left", "right", "top", "three_quarter", or your own {"name": "knee", "view": "side", "bone": "LeftLeg", "radius_mm": 150} (a close-up around a bone) or
            {"name": "x", "view": "front", "c": [x, y, z], "size": s} (centre in metres, the picture covers `size` metres); default ["front", "left"]
  bones     true (default): draw the bones. A list of bone names draws only those (the rest hidden)
  labels    true (default) / false: bone names as text; or a list of the bone names to label
  axes      list of bone names whose local axes are drawn (X red, Y green = along the bone, Z blue), or "all"
  weights   a bone name ("LeftLeg"), "influences" or "sum_error": the heat map on the skin (default none = the skin's own colours, grey where it has none)
  bones_at  "pose" (default): bones are drawn where the current pose puts them, so they sit inside the skin as it is deformed; "rest": at their rest position
  skin      "see_through" (default), "opaque" or "hidden"
  highlight bone names drawn yellow
  res       picture px (default 768)
Returns: pictures (file, view, covers), bones drawn, weights (what was painted and the vertices above 0.5 / the range), notes.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_modes as M  # noqa: E402
import rig_common as R  # noqa: E402

PRE = R.PREFIX
DIRS = {"front": (0, -1, 0), "back": (0, 1, 0), "left": (1, 0, 0), "right": (-1, 0, 0), "top": (0, 0, 1), "side": (1, 0, 0), "three_quarter": (0.6, -0.8, 0.35)}


def flat(name, rgba):
    m = bpy.data.materials.new(name)
    m.diffuse_color = rgba
    return m


def shape(arm, b, w, ev=None):
    """a bone as a solid; with `ev` (the evaluated armature) it is drawn where the current pose puts it, else at rest"""
    mw = arm.matrix_world
    pb = ev.pose.bones.get(b.name) if ev is not None else None
    h, t = (mw @ pb.head, mw @ pb.tail) if pb is not None else (mw @ b.head_local, mw @ b.tail_local)
    d = t - h
    ln = d.length
    if ln < 1e-6:
        return [], []
    dn = d / ln
    u = dn.cross(Vector((0, 0, 1)))
    if u.length < 1e-3:
        u = dn.cross(Vector((1, 0, 0)))
    u.normalize()
    v = dn.cross(u).normalized()
    r = max(w, min(ln * 0.1, 0.02))
    ring = [h + dn * ln * 0.2 + u * r, h + dn * ln * 0.2 + v * r, h + dn * ln * 0.2 - u * r, h + dn * ln * 0.2 - v * r]
    verts = [h, t] + ring
    faces = [(0, 2, 3), (0, 3, 4), (0, 4, 5), (0, 5, 2), (1, 3, 2), (1, 4, 3), (1, 5, 4), (1, 2, 5)]
    return verts, faces


def solid(name, items, mat):
    vs, fs = [], []
    for v, f in items:
        o = len(vs)
        vs += [tuple(x) for x in v]
        fs += [tuple(i + o for i in tri) for tri in f]
    if not vs:
        return None
    me = bpy.data.meshes.new(name)
    me.from_pydata(vs, [], fs)
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    ca = me.color_attributes.new("rigview", "FLOAT_COLOR", "POINT")  # for the heat-map shading (vertex colour): a solid colour per object
    ca.data.foreach_set("color", np.tile(np.array(mat.diffuse_color, dtype=np.float32), len(me.vertices)))
    me.color_attributes.active_color = ca
    bpy.context.scene.collection.objects.link(ob)
    return ob


def heat(x):
    x = np.clip(x, 0, 1)
    return np.stack([np.clip(2 * x - 1, 0, 1) + (x * 0), np.clip(1 - np.abs(2 * x - 1) * 1.0, 0, 1), np.clip(1 - 2 * x, 0, 1), np.ones_like(x)], axis=1)


def main():
    arm = R.find_rig()
    body = bpy.data.objects.get(L.param("body", "body"))
    if body is None or body.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('body', 'body')}")
    scn = bpy.context.scene
    res = int(L.param("res", 768))
    R.reset_pose(arm)
    M.workbench(scn, res)
    scn.render.image_settings.file_format = "PNG"
    for o in scn.objects:
        if o is not body:
            o.hide_render = True
    notes = []
    skin = L.param("skin", "see_through")
    wt = L.param("weights")
    # skin material / heat map
    sh = scn.display.shading
    painted = None
    if wt:
        V = len(body.data.vertices)
        W = np.zeros((V, len(body.vertex_groups)))
        for v in body.data.vertices:
            for g in v.groups:
                W[v.index, g.group] = g.weight
        names = [g.name for g in body.vertex_groups]
        if wt == "influences":
            val = np.clip(((W > 0.01).sum(1) - 1) / 4.0, 0, 1)
            painted = {"what": "influences per vertex (1 blue ... 5+ red)", "max": int((W > 0.01).sum(1).max())}
        elif wt == "sum_error":
            val = np.clip(np.abs(W.sum(1) - 1) / 0.5, 0, 1)
            painted = {"what": "|total weight - 1| (0 blue ... 0.5+ red)", "vertices_off_by_over_0.05": int((np.abs(W.sum(1) - 1) > 0.05).sum())}
        else:
            if PRE + wt not in names:
                raise RuntimeError(f"no group {wt}. Groups: {', '.join(n[len(PRE):] for n in names)}")
            val = W[:, names.index(PRE + wt)]
            painted = {"what": f"weight of {wt} (0 blue, 0.5 green, 1 red)", "vertices_above_0.5": int((val > 0.5).sum()), "vertices_above_0.01": int((val > 0.01).sum())}
        ca = body.data.color_attributes.new("rigview", "FLOAT_COLOR", "POINT")
        cols = heat(val)
        ca.data.foreach_set("color", cols.ravel().astype(np.float32))
        body.data.color_attributes.active_color = ca
        sh.color_type = "VERTEX"
    else:
        sh.color_type = "TEXTURE"
    if skin == "hidden":
        body.hide_render = True
    else:
        body.hide_render = False
        if skin == "see_through":
            for m in body.data.materials:
                if m:
                    m.diffuse_color[3] = 0.32
            body.show_transparent = True
    # bones
    bpy.context.view_layer.update()
    ev_arm = arm.evaluated_get(bpy.context.evaluated_depsgraph_get()) if L.param("bones_at", "pose") == "pose" else None
    want = L.param("bones", True)
    draw = [b for b in arm.data.bones if want is True or (isinstance(want, list) and b.name[len(PRE):] in want)] if want else []
    hl = set(L.param("highlight") or [])
    groups = {"left": [], "right": [], "centre": [], "pick": []}
    for b in draw:
        n = b.name[len(PRE):]
        key = "pick" if n in hl else "left" if n.startswith("Left") else "right" if n.startswith("Right") else "centre"
        groups[key].append(shape(arm, b, 0.006, ev_arm))
    cols = {"left": (0.15, 0.35, 1, 1), "right": (1, 0.25, 0.2, 1), "centre": (0.2, 0.85, 0.3, 1), "pick": (1, 0.9, 0.1, 1)}
    for k, items in groups.items():
        ob = solid("bones-" + k, items, flat("bm-" + k, cols[k]))
        if ob is not None:
            ob.show_in_front = True
    # axes
    ax = L.param("axes") or []
    if ax == "all":
        ax = [b.name[len(PRE):] for b in arm.data.bones]
    ac = {0: (1, 0.1, 0.1, 1), 1: (0.1, 0.9, 0.1, 1), 2: (0.2, 0.4, 1, 1)}
    for i in range(3):
        items = []
        for n in ax:
            b = arm.data.bones.get(PRE + n)
            if b is None:
                raise RuntimeError(f"no bone {n}")
            m = arm.matrix_world @ (ev_arm.pose.bones[b.name].matrix if ev_arm is not None else b.matrix_local)
            o = m.translation
            d = Vector((m[0][i], m[1][i], m[2][i])).normalized()
            ln = max(0.04, min(0.08, b.length * arm.matrix_world.to_scale()[0] * 0.5))
            u = d.cross(Vector((0, 0, 1)))
            if u.length < 1e-3:
                u = d.cross(Vector((1, 0, 0)))
            u.normalize()
            v = d.cross(u).normalized()
            r = 0.0025
            ring = [o + d * ln * 0.1 + u * r, o + d * ln * 0.1 + v * r, o + d * ln * 0.1 - u * r, o + d * ln * 0.1 - v * r]
            items.append(([o, o + d * ln] + ring, [(0, 2, 3), (0, 3, 4), (0, 4, 5), (0, 5, 2), (1, 3, 2), (1, 4, 3), (1, 5, 4), (1, 2, 5)]))
        ob = solid(f"axes-{i}", items, flat(f"am-{i}", ac[i]))
        if ob is not None:
            ob.show_in_front = True
    # camera and views
    cam = bpy.data.objects.new("rvcam", bpy.data.cameras.new("rvcam"))
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam.data.type = "ORTHO"
    cam.data.clip_start, cam.data.clip_end = 0.01, 60
    # labels
    lab = L.param("labels", True)
    labs = []
    if lab:
        lm = bpy.data.materials.new("lbl")
        lm.diffuse_color = (1, 1, 1, 1)
        for b in draw:
            n = b.name[len(PRE):]
            if lab is True or n in lab:
                c = bpy.data.curves.new("l-" + n, "FONT")
                c.body = n
                c.size = 0.018
                c.align_x = "LEFT"
                o = bpy.data.objects.new("l-" + n, c)
                o.location = arm.matrix_world @ (ev_arm.pose.bones[b.name].head if ev_arm is not None else b.head_local) + Vector((0.01, 0, 0.008))
                o.data.materials.append(lm)
                con = o.constraints.new("TRACK_TO")
                con.target = cam
                con.track_axis = "TRACK_Z"
                con.up_axis = "UP_Y"
                scn.collection.objects.link(o)
                o.show_in_front = True
                labs.append(o)
    allv = np.array([(body.matrix_world @ v.co)[:] for v in body.data.vertices])
    H = float(allv[:, 2].max() - allv[:, 2].min())
    mid = (allv.max(0) + allv.min(0)) / 2
    out_dir = L.ARGS["out_dir"]
    pics = []
    for v in (L.param("views") or ["front", "left"]):
        if isinstance(v, str):
            name, view, c, size = v, v, mid, H * 1.15
        else:
            name, view = v.get("name", v.get("view", "view")), v.get("view", "front")
            if "bone" in v:
                b = arm.data.bones.get(PRE + v["bone"])
                if b is None:
                    raise RuntimeError(f"no bone {v['bone']}")
                c = np.array(arm.matrix_world @ (((ev_arm.pose.bones[b.name].head + ev_arm.pose.bones[b.name].tail) if ev_arm is not None else (b.head_local + b.tail_local)) / 2))
                size = 2 * float(v.get("radius_mm", 150)) / 1000
            else:
                c = np.array(v.get("c", mid), float)
                size = float(v.get("size", H * 1.15))
        if view not in DIRS:
            raise RuntimeError(f"view must be one of {', '.join(DIRS)}")
        d = Vector(DIRS[view]).normalized()
        cam.location = Vector(c) + d * 6
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y" if view != "top" else "Y").to_euler()
        cam.data.ortho_scale = size
        p = os.path.join(out_dir, f"rigview-{name}.png")
        scn.render.filepath = p
        bpy.ops.render.render(write_still=True)
        pics.append({"file": os.path.basename(p), "view": view, "covers_m": round(size, 3), "centre_m": [round(float(x), 3) for x in c]})
    L.finish({"pictures": pics, "bones_drawn": len(draw), "labels": len(labs), "weights": painted, "notes": notes}, files=[os.path.join(out_dir, x["file"]) for x in pics], save=False)


L.run(main)
