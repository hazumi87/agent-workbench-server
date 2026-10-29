"""kit_render — render named, FIXED cameras of the whole scene (all meshes), one PNG per shot.

params:
  shots   [{name, view, centre:[x,y,z] (metres), size (ortho scale, metres)}]   view: front|back|left|right|top
  res     default 768
  prefix  file name prefix (default "kit")
Cameras are in world metres, so they do not move between rounds.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402

DIRS = {"front": Vector((0, -1, 0)), "back": Vector((0, 1, 0)), "left": Vector((1, 0, 0)),
        "right": Vector((-1, 0, 0)), "top": Vector((0, 0, 1)), "three_quarter": Vector((0.7, -0.7, 0))}


def main():
    scn = bpy.context.scene
    ms = L.meshes()
    for o in bpy.context.scene.objects:
        o.hide_render = o not in ms
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = int(L.param("samples", 24))
    scn.cycles.use_denoising = True
    res = int(L.param("res", 768))
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.image_settings.file_format = "PNG"
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    scn.world.node_tree.nodes["Background"].inputs[0].default_value = (0.18, 0.18, 0.2, 1)
    scn.world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.0
    scn.collection.objects.link(sun)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    cam.data.type = "ORTHO"
    cam.data.clip_end = 100
    scn.collection.objects.link(cam)
    scn.camera = cam
    prefix = L.param("prefix", "kit")
    files = []
    for sh in L.param("shots"):
        d = DIRS[sh["view"]].normalized()
        centre = Vector(sh["centre"])
        cam.data.ortho_scale = float(sh["size"])
        cam.location = centre + d * 5
        up = "Y" if sh["view"] != "top" else "Y"
        cam.rotation_euler = (-d).to_track_quat("-Z", up).to_euler()
        sun.rotation_euler = (-(d + Vector((0.3, 0, 0.6))).normalized()).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(L.ARGS["out_dir"], f"{prefix}-{sh['name']}.png")
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
    L.finish({"rendered": [os.path.basename(f) for f in files]}, files=files)


L.run(main)