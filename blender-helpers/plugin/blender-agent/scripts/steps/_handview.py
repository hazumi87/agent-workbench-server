"""_handview - clay pictures of hand objects (Workbench, orthographic, fixed directions): shared by hand_make and hand_pose (not a verb)."""
import os

import bpy
from mathutils import Vector

import _lib as L
import kit2_modes as M


def render_views(objs, centre, size_m, prefix, res=640, dirs=None, cam_offsets=None, fov_deg=30, color_type="MATERIAL"):
    """clay Workbench pictures of `objs` from fixed directions (orthographic cameras `size_m` across, centred on `centre`); with `cam_offsets` {name: [dx, dy, dz] metres from `centre`} perspective cameras at those positions looking at `centre` instead"""
    scn = bpy.context.scene
    M.workbench(scn, res)
    scn.display.shading.color_type = color_type  # "OBJECT" shows each object in its own object colour
    cam_d = bpy.data.cameras.new("hv")
    if cam_offsets:
        import math
        cam_d.type = "PERSP"
        cam_d.lens_unit = "FOV"
        cam_d.angle = math.radians(fov_deg)
    else:
        cam_d.type = "ORTHO"
        cam_d.ortho_scale = size_m
    dist = max(2.0, float(size_m) * 1.5)  # the orthographic camera stands this far from the centre: a big scene (a site, a room) must not reach behind it, or the near plane cuts triangles out of the picture
    cam_d.clip_start, cam_d.clip_end = 0.01, max(20.0, dist + float(size_m) * 2.0)
    cam = bpy.data.objects.new("hv", cam_d)
    scn.collection.objects.link(cam)
    scn.camera = cam
    hid0 = {o.name: o.hide_render for o in scn.objects}  # put back after the pictures: a render must not leave objects hidden in the saved checkpoint
    for o in scn.objects:
        o.hide_render = o not in objs
    files = []
    for nm, d in (dirs or {}).items():
        d = Vector(d).normalized()
        cam.location = centre + d * dist
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(L.ARGS["out_dir"], f"{prefix}-{nm}.png")
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
    for nm, off in (cam_offsets or {}).items():
        cam.location = Vector(centre) + Vector(off)
        cam.rotation_euler = (Vector(centre) - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(L.ARGS["out_dir"], f"{prefix}-{nm}.png")
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
    bpy.data.objects.remove(cam, do_unlink=True)
    for o in scn.objects:
        if o.name in hid0:
            o.hide_render = hid0[o.name]
    return files


def render_views_pbr(objs, centre, size_m, prefix, res=640, dirs=None, samples=24, perspective_fov_deg=None, cam_offsets=None):
    """pictures of `objs` WITH their materials (Cycles on the CPU, a three-light studio, Standard view transform), from fixed directions (orthographic) or, when `cam_offsets` {name: [dx, dy, dz] metres from `centre`} is given, from those positions with a perspective lens"""
    import math
    scn = bpy.context.scene
    old = (scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage, scn.camera, scn.world)
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = int(samples)
    scn.cycles.use_denoising = False
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.resolution_percentage = 100
    scn.render.film_transparent = False
    scn.view_settings.view_transform = "Standard"
    scn.view_settings.look = "None"
    w = bpy.data.worlds.new("hv-world")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.8, 0.8, 0.8, 1.0)
    bg.inputs[1].default_value = 0.6
    scn.world = w
    cam_d = bpy.data.cameras.new("hvp")
    if cam_offsets:
        cam_d.type = "PERSP"
        cam_d.lens_unit = "FOV"
        cam_d.angle = math.radians(perspective_fov_deg or 30)
    else:
        cam_d.type = "ORTHO"
        cam_d.ortho_scale = size_m
    sc_ = max(1.0, float(size_m) / 1.4)  # a big scene (a site, a room) needs the camera, the clip range and the three lamps scaled with it: a fixed 2 m camera cuts the scene with its near plane and 1.2 m lamps barely light it
    cam_d.clip_start, cam_d.clip_end = 0.01, max(20.0, 6.0 * sc_)
    cam = bpy.data.objects.new("hvp", cam_d)
    scn.collection.objects.link(cam)
    scn.camera = cam
    hid = {o.name: o.hide_render for o in scn.objects}
    for o in scn.objects:
        o.hide_render = o not in objs and o is not cam and o.type != "LIGHT"
    files, lights = [], []

    def lamp(direction, energy, size_, colour=(1, 1, 1)):
        d = bpy.data.lights.new("hvl", "AREA")
        d.energy, d.size, d.color = energy * sc_ ** 2, size_ * sc_, colour
        o = bpy.data.objects.new("hvl", d)
        scn.collection.objects.link(o)
        o.location = Vector(centre) + Vector(direction).normalized() * 1.2 * sc_
        o.rotation_euler = (-Vector(direction)).to_track_quat("-Z", "Y").to_euler()
        lights.append(o)
    items = [(nm, None, Vector(d).normalized()) for nm, d in (dirs or {}).items()] + [(nm, Vector(off), Vector(off).normalized()) for nm, off in (cam_offsets or {}).items()]
    for nm, off, d in items:
        cam.location = (Vector(centre) + off) if off is not None else (Vector(centre) + d * 2.0 * sc_)
        cam.rotation_euler = ((Vector(centre) - cam.location)).to_track_quat("-Z", "Y").to_euler()
        for o in lights:
            bpy.data.objects.remove(o, do_unlink=True)
        lights.clear()
        right = (-d).cross(Vector((0, 0, 1)))
        right = right.normalized() if right.length > 1e-6 else Vector((1, 0, 0))
        upv = right.cross(-d).normalized()
        lamp(d + upv * 0.8 - right * 0.7, 14, 0.8)
        lamp(d + upv * 0.2 + right * 1.0, 5, 1.0, (0.85, 0.9, 1.0))
        lamp(-d + upv * 0.8, 5, 0.6)
        path = os.path.join(L.ARGS["out_dir"], f"{prefix}-{nm}.png")
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
    for o in lights + [cam]:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in scn.objects:
        if o.name in hid:
            o.hide_render = hid[o.name]
    scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage, scn.camera, scn.world = old
    return files
