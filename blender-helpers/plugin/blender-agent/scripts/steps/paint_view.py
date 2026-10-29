"""paint_view — look at a painted mesh with its real materials (full PBR: base colour, roughness, metallic, normal map), lit by a simple studio light, from named directions, with the normal map on and/or off. Saves nothing (reads only).

Cycles on the CPU at a low sample count: a few seconds a picture for a hand. The scene is not changed (lights, camera and the render settings are removed or restored). Use it to show the painted hand, with PBR on, before it is joined to the body, and again after hand_attach.

params:
  mesh      the object (default "hand_L"); more than one: "meshes": [...] (e.g. the joined body and the hand)
  views     list of "palm" | "back" | "thumb" | "oblique" | "end" | "end_oblique" | {"name": "mine", "dir": [x, y, z]} (default ["back", "palm"]) — directions from the mesh to the camera; `palm` [0, 0, -1] is the palm normal for the named views (default T-pose, palm down)
  centre    [x, y, z] mm to look at (default the object's bounding-box centre); size_mm the picture's width in mm (default 1.5 x the object's largest extent)
  res       px (default 720); samples (default 24)
  normal    "on" (default) | "off" | "both" (both writes <prefix>-<view>-nrm.png and <prefix>-<view>-flat.png)
  light     [x, y, z] the key light's direction from the mesh (default: above and to the camera's left of the first view); fill and rim lights are added; `exposure` stops (default 0)
  prefix    file stem in out/ (default "paintview")
Returns the files, the materials found per object (images and their colour spaces, a normal map node or not), notes.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def main():
    names = L.param("meshes") or [L.param("mesh", "hand_L")]
    objs = [bpy.data.objects.get(n) for n in names]
    if any(o is None for o in objs):
        raise RuntimeError(f"no such object in {names}")
    scn = bpy.context.scene
    palm = Vector(L.param("palm", [0, 0, -1])).normalized()
    pts = np.array([(o.matrix_world @ Vector(c))[:] for o in objs for c in o.bound_box])
    ctr = Vector(L.param("centre") and [x / 1000 for x in L.param("centre")] or ((pts.min(0) + pts.max(0)) / 2).tolist())
    ext = float(np.ptp(pts, axis=0).max())
    size = float(L.param("size_mm", ext * 1000 * 1.5)) / 1000
    res = int(L.param("res", 720))
    prefix = L.param("prefix", "paintview")
    nmode = L.param("normal", "on")
    # the hand's side direction for "thumb": palm x forearm; here simply any perpendicular
    up = Vector((0, 0, 1)) if abs(palm.z) < 0.9 else Vector((1, 0, 0))
    side = palm.cross(up).normalized()
    fwd = side.cross(palm).normalized()
    named = {"palm": palm, "back": -palm, "thumb": side, "oblique": (palm * 0.7 + side * 0.5 - fwd * 0.4), "end": fwd, "end_oblique": (fwd * 0.8 + palm * 0.4 + side * 0.2)}
    views = []
    for v in (L.param("views") or ["back", "palm"]):
        if isinstance(v, dict):
            views.append((v["name"], Vector(v["dir"]).normalized()))
        else:
            views.append((v, Vector(named[v]).normalized()))
    old = {"engine": scn.render.engine, "res": (scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage), "cam": scn.camera, "world": scn.world}
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = int(L.param("samples", 24))
    scn.cycles.use_denoising = False
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.resolution_percentage = 100
    scn.render.film_transparent = False
    scn.view_settings.view_transform = "Standard"  # no tone-mapping: a texture reads close to its own colours
    scn.view_settings.look = "None"
    scn.view_settings.exposure = float(L.param("exposure", 0.0))
    w = bpy.data.worlds.new("pv-world")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.8, 0.8, 0.8, 1.0)
    bg.inputs[1].default_value = 0.6
    scn.world = w
    made = []
    lights = []

    def lamp(kind, direction, energy, size_=1.0, colour=(1, 1, 1)):
        d = bpy.data.lights.new("pv", kind)
        d.energy = energy
        d.color = colour
        if kind == "AREA":
            d.size = size_
        o = bpy.data.objects.new("pv", d)
        scn.collection.objects.link(o)
        o.location = ctr + direction.normalized() * 1.2
        o.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
        lights.append(o)
        return o
    cam_d = bpy.data.cameras.new("pv")
    cam_d.type = "ORTHO"
    cam_d.ortho_scale = size
    cam_d.clip_start, cam_d.clip_end = 0.01, 20
    cam = bpy.data.objects.new("pv", cam_d)
    scn.collection.objects.link(cam)
    scn.camera = cam
    made.append(cam)
    hid = {o.name: o.hide_render for o in scn.objects}
    for o in scn.objects:
        o.hide_render = o not in objs and o not in made and o.type != "LIGHT"
    # materials report; normal map strength toggles
    nodes = []
    mats = {}
    for o in objs:
        lst = []
        for m in o.data.materials:
            if m is None or not m.use_nodes:
                continue
            imgs = [(nd.image.name if nd.image else None, nd.image.colorspace_settings.name if nd.image else None) for nd in m.node_tree.nodes if nd.type == "TEX_IMAGE"]
            nm = [nd for nd in m.node_tree.nodes if nd.type == "NORMAL_MAP"]
            nodes += [(nd, nd.inputs["Strength"].default_value) for nd in nm]
            lst.append({"material": m.name, "images": imgs, "normal_map_node": bool(nm)})
        mats[o.name] = lst
    files = []
    modes = ["on", "off"] if nmode == "both" else [nmode]
    key_dir = Vector(L.param("light")) if L.param("light") else None
    for vn, d in views:
        cam.location = ctr + d * 2.0
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        # key from above-left of the camera, fill from the right, rim from behind
        right = (-d).cross(Vector((0, 0, 1)))
        right = right.normalized() if right.length > 1e-6 else Vector((1, 0, 0))
        upv = right.cross(-d).normalized()
        for o in lights:
            bpy.data.objects.remove(o, do_unlink=True)
        lights.clear()
        lamp("AREA", key_dir if key_dir is not None else (d + upv * 0.8 - right * 0.7), 14, 0.8)
        lamp("AREA", d + upv * 0.2 + right * 1.0, 5, 1.0, (0.85, 0.9, 1.0))
        lamp("AREA", -d + upv * 0.8, 5, 0.6)
        for mode in modes:
            for nd, st in nodes:
                nd.inputs["Strength"].default_value = st if mode == "on" else 0.0
            suffix = "" if len(modes) == 1 else ("-nrm" if mode == "on" else "-flat")
            path = os.path.join(L.ARGS["out_dir"], f"{prefix}-{vn}{suffix}.png")
            os.makedirs(L.ARGS["out_dir"], exist_ok=True)
            scn.render.filepath = path
            bpy.ops.render.render(write_still=True)
            files.append(path)
    for nd, st in nodes:
        nd.inputs["Strength"].default_value = st
    for o in lights + made:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in scn.objects:
        if o.name in hid:
            o.hide_render = hid[o.name]
    scn.render.engine = old["engine"]
    scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = old["res"]
    scn.camera = old["cam"]
    scn.world = old["world"]
    L.finish({"files": [os.path.basename(f) for f in files], "materials": mats, "notes": ["Cycles CPU, a simple three-light studio; the scene's lights/camera/world were restored"]}, files=files, save=False)


L.run(main)
